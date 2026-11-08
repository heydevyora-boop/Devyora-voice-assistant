import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { AuditAction, AuditService } from '../../security/services/audit.service';
import { PasswordService } from '../../security/services/password.service';
import { hashToken, TokenService } from '../../security/services/token.service';
import { MAIL_PROVIDER, type MailProvider } from '../../providers/mail/mail.provider';
import { nextSecond, startOfSecond } from '../../security/token-watermark';
import type {
  ChangePasswordDto,
  ClientType,
  DeviceRegistrationDto,
  LoginDto,
  RegisterDto,
} from './dto/auth.dto';

/** Lock an account after this many consecutive failures. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_DURATION_MS = 15 * 60_000;
const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24;
const PASSWORD_RESET_TTL_MINUTES = 30;

export interface RequestMeta {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface IssuedCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly refreshExpiresAt: Date;
  readonly csrfToken: string;
  readonly sessionId: string;
}

export interface AuthOutcome {
  readonly user: Pick<User, 'id' | 'email' | 'displayName' | 'emailVerifiedAt'>;
  readonly device: { id: string; publicId: string; platform: string; name: string };
  readonly credentials: IssuedCredentials;
  readonly clientType: ClientType;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}

  // ───────────────────────────────────────────────────────── registration

  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthOutcome> {
    const email = normaliseEmail(dto.email);
    this.passwords.assertStrong(dto.password);

    const passwordHash = await this.passwords.hash(dto.password);

    // The unique index is what actually prevents a duplicate; checking first
    // would still race. A conflict is caught and reported uniformly.
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          displayName: dto.displayName,
          // Floored to the second so the token issued moments later, whose
          // `iat` has one-second resolution, is not treated as stale.
          tokensValidFrom: startOfSecond(),
          preference: { create: {} },
        },
      });
    } catch {
      // Deliberately the same message a taken address produces, and the same
      // shape as success would take, so this endpoint cannot be used to
      // enumerate which addresses are registered.
      throw AppError.conflict('That email address cannot be registered.');
    }

    const device = await this.createDevice(user.id, dto.device);
    const credentials = await this.openSession(user, device.id, meta);

    await this.audit.record({
      action: AuditAction.USER_REGISTERED,
      userId: user.id,
      deviceId: device.id,
      ...meta,
    });

    // Best effort: a mail outage must not undo a completed registration.
    await this.sendEmailVerification(user).catch((error: unknown) => {
      this.logger.error(
        `Verification email not sent for ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return {
      user,
      device,
      credentials,
      clientType: dto.clientType ?? 'native',
    };
  }

  // ─────────────────────────────────────────────────────────────── login

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthOutcome> {
    const email = normaliseEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // One message for every failure mode below. An attacker learns nothing
    // about whether the address exists, is locked, or is suspended.
    const reject = () => AppError.unauthenticated('Email or password is incorrect.');

    if (!user || user.deletedAt) {
      // Still spend the time a real verification would, so a missing account
      // is not distinguishable by response time.
      await this.passwords.verify(DUMMY_HASH, dto.password);
      await this.audit.record({
        action: AuditAction.USER_LOGIN_FAILED,
        metadata: { reason: 'unknown-account' },
        ...meta,
      });
      throw reject();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record({
        action: AuditAction.USER_LOGIN_LOCKED,
        userId: user.id,
        metadata: { lockedUntil: user.lockedUntil.toISOString() },
        ...meta,
      });
      throw reject();
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.registerFailedAttempt(user, meta);
      throw reject();
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        action: AuditAction.USER_LOGIN_FAILED,
        userId: user.id,
        metadata: { reason: 'account-not-active', status: user.status },
        ...meta,
      });
      throw reject();
    }

    // Only now, after the password is proven, is a client-supplied device id
    // considered — and only if it belongs to this account.
    const device = await this.resolveDevice(user.id, dto.devicePublicId, dto.device);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const credentials = await this.openSession(user, device.id, meta);

    await this.audit.record({
      action: AuditAction.USER_LOGIN_SUCCEEDED,
      userId: user.id,
      deviceId: device.id,
      ...meta,
    });

    return { user, device, credentials, clientType: dto.clientType ?? 'native' };
  }

  private async registerFailedAttempt(user: User, meta: RequestMeta): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: locked ? 0 : attempts,
        lockedUntil: locked ? new Date(Date.now() + LOCK_DURATION_MS) : user.lockedUntil,
      },
    });

    await this.audit.record({
      action: locked ? AuditAction.USER_LOGIN_LOCKED : AuditAction.USER_LOGIN_FAILED,
      userId: user.id,
      metadata: { attempts, reason: 'bad-password' },
      ...meta,
    });
  }

  // ───────────────────────────────────────────────────────────── refresh

  /**
   * Rotates a refresh token.
   *
   * Presenting a token that has already been rotated is treated as theft:
   * either the legitimate client is replaying, or someone else has a copy.
   * Both cases are resolved the same way — end the session family — because
   * the two are indistinguishable from here and the safe reading is the
   * hostile one.
   */
  async refresh(plaintext: string, meta: RequestMeta): Promise<AuthOutcome> {
    const tokenHash = hashToken(plaintext);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        session: {
          include: {
            user: true,
            device: true,
          },
        },
      },
    });

    const reject = () => AppError.unauthenticated('The refresh token is not valid.');
    if (!stored) throw reject();

    const { session } = stored;

    if (stored.rotatedToId || stored.revokedAt) {
      await this.revokeSessionFamily(session.id);
      await this.audit.record({
        action: AuditAction.TOKEN_REUSE_DETECTED,
        userId: session.userId,
        deviceId: session.deviceId,
        resource: 'session',
        resourceId: session.id,
        metadata: { reason: stored.rotatedToId ? 'already-rotated' : 'revoked' },
        ...meta,
      });
      throw reject();
    }

    if (stored.expiresAt <= new Date()) throw reject();
    if (session.endedAt) throw reject();
    if (session.device.revokedAt) throw reject();
    if (session.user.deletedAt || session.user.status !== 'ACTIVE') throw reject();

    const next = this.tokens.issueRefreshToken();
    const access = await this.tokens.signAccessToken({
      sub: session.userId,
      sid: session.id,
      did: session.deviceId,
    });

    await this.prisma.transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: { sessionId: session.id, tokenHash: next.hash, expiresAt: next.expiresAt },
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { rotatedToId: created.id, revokedAt: new Date() },
      });
    });

    await this.audit.record({
      action: AuditAction.TOKEN_REFRESHED,
      userId: session.userId,
      deviceId: session.deviceId,
      ...meta,
    });

    return {
      user: session.user,
      device: {
        id: session.device.id,
        publicId: session.device.publicId,
        platform: session.device.platform,
        name: session.device.name,
      },
      credentials: {
        accessToken: access.token,
        refreshToken: next.plaintext,
        expiresIn: access.expiresInSeconds,
        refreshExpiresAt: next.expiresAt,
        csrfToken: randomBytes(24).toString('base64url'),
        sessionId: session.id,
      },
      clientType: 'native',
    };
  }

  // ────────────────────────────────────────────────────────────── logout

  async logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.revokeSessionFamily(sessionId);
    await this.audit.record({
      action: AuditAction.USER_LOGGED_OUT,
      userId,
      resource: 'session',
      resourceId: sessionId,
      ...meta,
    });
  }

  /**
   * Ends every session and invalidates access tokens already issued, by
   * moving the user's `tokensValidFrom` watermark forward.
   */
  async logoutEverywhere(userId: string, meta: RequestMeta): Promise<number> {
    const now = new Date();
    const watermark = nextSecond(now);

    const count = await this.prisma.transaction(async (tx) => {
      const sessions = await tx.session.findMany({
        where: { userId, endedAt: null },
        select: { id: true },
      });
      const ids = sessions.map((s) => s.id);

      if (ids.length > 0) {
        await tx.refreshToken.updateMany({
          where: { sessionId: { in: ids }, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session.updateMany({ where: { id: { in: ids } }, data: { endedAt: now } });
      }

      await tx.user.update({ where: { id: userId }, data: { tokensValidFrom: watermark } });
      return ids.length;
    });

    await this.audit.record({
      action: AuditAction.USER_LOGGED_OUT_ALL,
      userId,
      metadata: { sessionsEnded: count },
      ...meta,
    });
    return count;
  }

  async revokeSessionFamily(sessionId: string): Promise<void> {
    const now = new Date();
    await this.prisma.transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.session.updateMany({
        where: { id: sessionId, endedAt: null },
        data: { endedAt: now },
      });
    });
  }

  // ──────────────────────────────────────────────────────────── password

  async changePassword(userId: string, dto: ChangePasswordDto, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const valid = await this.passwords.verify(user.passwordHash, dto.currentPassword);
    if (!valid) throw AppError.unauthenticated('The current password is incorrect.');

    this.passwords.assertStrong(dto.newPassword);
    const passwordHash = await this.passwords.hash(dto.newPassword);
    const now = new Date();

    await this.prisma.transaction(async (tx) => {
      // The watermark moves, so every access token issued before this
      // moment stops working — a changed password must not leave a stolen
      // token usable for the rest of its lifetime.
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, tokensValidFrom: nextSecond(now) },
      });
      const sessions = await tx.session.findMany({
        where: { userId, endedAt: null },
        select: { id: true },
      });
      const ids = sessions.map((s) => s.id);
      if (ids.length > 0) {
        await tx.refreshToken.updateMany({
          where: { sessionId: { in: ids }, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session.updateMany({ where: { id: { in: ids } }, data: { endedAt: now } });
      }
    });

    await this.audit.record({ action: AuditAction.USER_PASSWORD_CHANGED, userId, ...meta });
  }

  /**
   * Always reports success, whether or not the address is registered.
   * Anything else turns this endpoint into an account-existence oracle.
   */
  async requestPasswordReset(rawEmail: string, meta: RequestMeta): Promise<void> {
    const email = normaliseEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || user.deletedAt || user.status !== 'ACTIVE') return;

    const token = this.tokens.issueVerificationToken(PASSWORD_RESET_TTL_MINUTES);

    await this.prisma.transaction(async (tx) => {
      // One live reset at a time: issuing a new link retires the old one.
      await tx.verificationToken.updateMany({
        where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.verificationToken.create({
        data: {
          userId: user.id,
          type: 'PASSWORD_RESET',
          tokenHash: token.hash,
          emailAtIssue: user.email,
          expiresAt: token.expiresAt,
        },
      });
    });

    await this.mail.sendPasswordReset({
      to: user.email,
      token: token.plaintext,
      expiresAt: token.expiresAt,
    });

    await this.audit.record({
      action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
      userId: user.id,
      ...meta,
    });
  }

  async confirmPasswordReset(plaintext: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const record = await this.consumeVerificationToken(plaintext, 'PASSWORD_RESET');

    this.passwords.assertStrong(newPassword);
    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();

    await this.prisma.transaction(async (tx) => {
      await tx.verificationToken.update({ where: { id: record.id }, data: { usedAt: now } });
      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          tokensValidFrom: nextSecond(now),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      // A reset is also the remedy for a compromised account, so every
      // existing session goes with it.
      const sessions = await tx.session.findMany({
        where: { userId: record.userId, endedAt: null },
        select: { id: true },
      });
      const ids = sessions.map((s) => s.id);
      if (ids.length > 0) {
        await tx.refreshToken.updateMany({
          where: { sessionId: { in: ids }, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.session.updateMany({ where: { id: { in: ids } }, data: { endedAt: now } });
      }
    });

    await this.audit.record({
      action: AuditAction.USER_PASSWORD_RESET_COMPLETED,
      userId: record.userId,
      ...meta,
    });
  }

  // ──────────────────────────────────────────────────── email verification

  async sendEmailVerification(user: Pick<User, 'id' | 'email' | 'emailVerifiedAt'>): Promise<void> {
    if (user.emailVerifiedAt) return;

    const token = this.tokens.issueVerificationToken(EMAIL_VERIFICATION_TTL_MINUTES);

    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFICATION',
        tokenHash: token.hash,
        emailAtIssue: user.email,
        expiresAt: token.expiresAt,
      },
    });

    await this.mail.sendEmailVerification({
      to: user.email,
      token: token.plaintext,
      expiresAt: token.expiresAt,
    });

    await this.audit.record({
      action: AuditAction.USER_EMAIL_VERIFICATION_SENT,
      userId: user.id,
    });
  }

  /**
   * Marks the address verified — but only against a token that was really
   * issued, is unused, unexpired, and was issued for the address the account
   * still has. Nothing in this codebase sets `emailVerifiedAt` any other way.
   */
  async verifyEmail(plaintext: string, meta: RequestMeta): Promise<void> {
    const record = await this.consumeVerificationToken(plaintext, 'EMAIL_VERIFICATION');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    if (user.email !== record.emailAtIssue) {
      // The address changed after the link was sent; the old link must not
      // verify the new address.
      throw AppError.validation('This verification link is no longer valid.');
    }

    await this.prisma.transaction(async (tx) => {
      await tx.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    });

    await this.audit.record({
      action: AuditAction.USER_EMAIL_VERIFIED,
      userId: record.userId,
      ...meta,
    });
  }

  private async consumeVerificationToken(plaintext: string, type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET') {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(plaintext) },
    });

    // One message for wrong, used, expired and wrong-type.
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= new Date()) {
      throw AppError.validation('This link is invalid or has expired.');
    }
    return record;
  }

  // ───────────────────────────────────────────────────────────── helpers

  private async createDevice(userId: string, dto: DeviceRegistrationDto) {
    return this.prisma.device.create({
      data: {
        userId,
        // Server-generated. A client-supplied value is never used as the
        // device's identity.
        publicId: randomBytes(16).toString('base64url'),
        platform: dto.platform,
        name: dto.name,
        deviceType: dto.deviceType,
        appVersion: dto.appVersion,
        wakeWordCapable: dto.wakeWordCapable ?? false,
        lastSeenAt: new Date(),
      },
      select: { id: true, publicId: true, platform: true, name: true },
    });
  }

  private async resolveDevice(
    userId: string,
    publicId: string | undefined,
    dto: DeviceRegistrationDto,
  ) {
    if (publicId) {
      const existing = await this.prisma.device.findFirst({
        // Scoped to this user: a device id belonging to someone else simply
        // does not match, and a new device is created instead.
        where: { publicId, userId, revokedAt: null },
        select: { id: true, publicId: true, platform: true, name: true },
      });
      if (existing) {
        await this.prisma.device.update({
          where: { id: existing.id },
          data: {
            name: dto.name,
            deviceType: dto.deviceType,
            appVersion: dto.appVersion,
            wakeWordCapable: dto.wakeWordCapable ?? undefined,
            lastSeenAt: new Date(),
          },
        });
        return existing;
      }
    }
    return this.createDevice(userId, dto);
  }

  private async openSession(
    user: Pick<User, 'id'>,
    deviceId: string,
    meta: RequestMeta,
  ): Promise<IssuedCredentials> {
    const refresh = this.tokens.issueRefreshToken();

    const session = await this.prisma.transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.session.create({
        data: {
          userId: user.id,
          deviceId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent?.slice(0, 500),
        },
      });
      await tx.refreshToken.create({
        data: { sessionId: created.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt },
      });
      return created;
    });

    const access = await this.tokens.signAccessToken({
      sub: user.id,
      sid: session.id,
      did: deviceId,
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.plaintext,
      expiresIn: access.expiresInSeconds,
      refreshExpiresAt: refresh.expiresAt,
      csrfToken: randomBytes(24).toString('base64url'),
      sessionId: session.id,
    };
  }
}

/** Case-insensitive uniqueness without the citext extension. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A real Argon2id hash of a value nobody knows, verified against when the
 * account does not exist so that timing does not reveal which addresses are
 * registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$8sMCl5pJdYBmBGPcHPb0m4CiCWDsK3dDJCWUMcBHHLo';
