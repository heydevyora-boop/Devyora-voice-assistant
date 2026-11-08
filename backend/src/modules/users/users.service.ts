import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { nextSecond } from '../../security/token-watermark';
import type { RequestMeta } from '../auth/auth.service';
import type { UpdateProfileDto } from './dto/users.dto';

/** The public shape of a user. A password hash can never reach a response. */
const PROFILE_SELECT = {
  id: true,
  email: true,
  displayName: true,
  locale: true,
  timezone: true,
  status: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async profile(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (!user) throw AppError.notFound('User');
    return { ...user, emailVerified: user.emailVerifiedAt !== null };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto, meta: RequestMeta) {
    // The email address is deliberately not editable here. Changing it has
    // to re-run verification and invalidate pending links, which is its own
    // flow rather than a field on a profile update.
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        displayName: dto.displayName,
        locale: dto.locale,
        timezone: dto.timezone,
      },
      select: PROFILE_SELECT,
    });

    await this.audit.record({
      action: AuditAction.USER_PROFILE_UPDATED,
      userId,
      metadata: { fields: Object.keys(dto) },
      ...meta,
    });

    return { ...user, emailVerified: user.emailVerifiedAt !== null };
  }

  /**
   * Suspends the account and ends every session. Reversible by an operator;
   * distinct from deletion, which schedules removal.
   */
  async deactivate(userId: string, meta: RequestMeta) {
    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: 'SUSPENDED', tokensValidFrom: nextSecond(now) },
      });
      await tx.session.updateMany({ where: { userId, endedAt: null }, data: { endedAt: now } });
      await tx.refreshToken.updateMany({
        where: { session: { userId }, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    await this.audit.record({ action: AuditAction.USER_DEACTIVATED, userId, ...meta });
    return { status: 'SUSPENDED' as const };
  }

  /**
   * Starts deletion.
   *
   * Soft-deletes immediately so access stops at once, and leaves the rows
   * for a grace period during which the account can be restored. The purge
   * job that removes them for good arrives with the background workers; the
   * response says so rather than implying the data is already gone.
   */
  async requestDeletion(userId: string, meta: RequestMeta) {
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { status: 'PENDING_DELETION', deletedAt: now, tokensValidFrom: nextSecond(now) },
      });
      await tx.session.updateMany({ where: { userId, endedAt: null }, data: { endedAt: now } });
      await tx.refreshToken.updateMany({
        where: { session: { userId }, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.device.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    });

    await this.audit.record({
      action: AuditAction.USER_DELETION_REQUESTED,
      userId,
      metadata: { purgeAfter: purgeAfter.toISOString() },
      ...meta,
    });

    return {
      status: 'PENDING_DELETION' as const,
      deletedAt: now,
      purgeAfter,
      note: 'Access has ended. Stored data is removed permanently after the grace period.',
    };
  }

  /**
   * Everything held about the account, as one document.
   *
   * Synchronous while volumes are small. Credentials are excluded by
   * construction — the password hash and stored tokens are not in any of
   * these selections, because an export is a file a person may email to
   * themselves.
   */
  async exportData(userId: string, meta: RequestMeta) {
    const [user, devices, sessions, notes, reminders, conversations, preference, connections] =
      await Promise.all([
        this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_SELECT }),
        this.prisma.device.findMany({
          where: { userId },
          select: {
            publicId: true, platform: true, name: true, deviceType: true,
            appVersion: true, createdAt: true, lastSeenAt: true, revokedAt: true,
          },
        }),
        this.prisma.session.findMany({
          where: { userId },
          select: { id: true, startedAt: true, endedAt: true, ipAddress: true, userAgent: true },
          orderBy: { startedAt: 'desc' },
          take: 200,
        }),
        this.prisma.note.findMany({
          where: { userId, deletedAt: null },
          select: { text: true, pinned: true, createdAt: true, updatedAt: true },
        }),
        this.prisma.reminder.findMany({
          where: { userId, deletedAt: null },
          select: { text: true, dueAt: true, timezone: true, status: true, createdAt: true },
        }),
        this.prisma.conversation.findMany({
          where: { userId, deletedAt: null },
          select: {
            title: true, createdAt: true,
            messages: { select: { role: true, content: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
          },
        }),
        this.prisma.userPreference.findUnique({
          where: { userId },
          select: { assistant: true, voice: true, appearance: true, privacy: true },
        }),
        this.prisma.connectedAccount.findMany({
          where: { userId },
          // Token columns are omitted on purpose; an export must never
          // carry a credential for a third-party account.
          select: { provider: true, displayName: true, scopes: true, status: true, createdAt: true },
        }),
      ]);

    await this.audit.record({ action: AuditAction.USER_DATA_EXPORTED, userId, ...meta });

    return {
      exportedAt: new Date().toISOString(),
      format: 'devyora.export.v1',
      user,
      devices,
      sessions,
      notes,
      reminders,
      conversations,
      preference,
      connectedAccounts: connections,
    };
  }

  /** Open sessions, so the user can see where they are signed in. */
  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        ipAddress: true,
        userAgent: true,
        device: { select: { publicId: true, name: true, platform: true, deviceType: true, revokedAt: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });

    return sessions.map((s) => ({
      ...s,
      active: s.endedAt === null && s.device.revokedAt === null,
      current: s.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string, meta: RequestMeta) {
    // Scoped to the owner: another user's session id simply does not match,
    // and the response is the same 404 a non-existent id would produce.
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });
    if (!session) throw AppError.notFound('Session');

    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.session.updateMany({ where: { id: sessionId, endedAt: null }, data: { endedAt: now } });
    });

    await this.audit.record({
      action: AuditAction.SESSION_REVOKED,
      userId,
      resource: 'session',
      resourceId: sessionId,
      ...meta,
    });
  }
}
