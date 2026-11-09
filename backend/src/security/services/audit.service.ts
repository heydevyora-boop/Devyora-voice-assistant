import { Injectable, Logger } from '@nestjs/common';
import type { ActorType } from '@prisma/client';
import { requestContext } from '../../common/request-context';
import { PrismaService } from '../../database/prisma.service';

/** Actions worth a permanent record. Strings, so adding one needs no migration. */
export const AuditAction = {
  USER_REGISTERED: 'user.registered',
  USER_LOGIN_SUCCEEDED: 'user.login.succeeded',
  USER_LOGIN_FAILED: 'user.login.failed',
  USER_LOGIN_LOCKED: 'user.login.locked',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_LOGGED_OUT_ALL: 'user.logged_out_all',
  USER_PROFILE_UPDATED: 'user.profile.updated',
  USER_PASSWORD_CHANGED: 'user.password.changed',
  USER_PASSWORD_RESET_REQUESTED: 'user.password.reset_requested',
  USER_PASSWORD_RESET_COMPLETED: 'user.password.reset_completed',
  USER_EMAIL_VERIFICATION_SENT: 'user.email.verification_sent',
  USER_EMAIL_VERIFIED: 'user.email.verified',
  USER_DEACTIVATED: 'user.deactivated',
  USER_DELETION_REQUESTED: 'user.deletion_requested',
  USER_DATA_EXPORTED: 'user.data_exported',
  TOKEN_REFRESHED: 'token.refreshed',
  TOKEN_REUSE_DETECTED: 'token.reuse_detected',
  SESSION_REVOKED: 'session.revoked',
  DEVICE_REGISTERED: 'device.registered',
  DEVICE_UPDATED: 'device.updated',
  DEVICE_REVOKED: 'device.revoked',
  // An AI-proposed action is recorded separately from a user action, and
  // approval is recorded separately from execution, so a reader of this
  // table can always tell which of the three actually happened.
  ASSISTANT_TURN_FAILED: 'assistant.turn.failed',
  ASSISTANT_ACTION_PROPOSED: 'assistant.action.proposed',
  ASSISTANT_ACTION_APPROVED: 'assistant.action.approved',
  ASSISTANT_ACTION_REJECTED: 'assistant.action.rejected',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditActionValue;
  userId?: string | null;
  deviceId?: string | null;
  actorType?: ActorType;
  resource?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only record of security-relevant events.
 *
 * Two rules. Writing an audit row must never fail the operation it describes
 * — a logging outage is not a reason to reject a login — so failures are
 * swallowed and reported to the logger. And no credential ever reaches this
 * table: callers pass identifiers and outcomes, never passwords or tokens.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    const context = requestContext.get();

    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          userId: entry.userId ?? context?.userId ?? null,
          deviceId: entry.deviceId ?? context?.deviceId ?? null,
          actorType: entry.actorType ?? 'USER',
          resource: entry.resource,
          resourceId: entry.resourceId,
          metadata: {
            correlationId: context?.correlationId ?? null,
            ...scrub(entry.metadata ?? {}),
          },
          ipAddress: entry.ipAddress ?? undefined,
          userAgent: entry.userAgent?.slice(0, 500),
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit entry "${entry.action}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const FORBIDDEN_KEYS = /pass|secret|token|hash|authorization|cookie|credential/i;

/**
 * Last line of defence against a caller passing something sensitive.
 * Keys that look like a credential are replaced, not dropped, so a review
 * can see that something was redacted rather than silently absent.
 */
function scrub(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    safe[key] = FORBIDDEN_KEYS.test(key) ? '[redacted]' : value;
  }
  return safe;
}
