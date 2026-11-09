import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationStatus,
  Prisma,
  type DevicePlatform,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PageDto, PageMetaDto, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import { PushError, isTokenRejection } from '../../providers/push/errors';
import { PushRegistry } from '../../providers/push/push.module';
import { parseNotificationPreferences } from './notification-preferences';

const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  channel: true,
  title: true,
  body: true,
  payload: true,
  status: true,
  attemptCount: true,
  providerId: true,
  deviceId: true,
  sentAt: true,
  readAt: true,
  failureCode: true,
  createdAt: true,
} as const;

export interface QueueNotificationInput {
  readonly userId: string;
  /** A short, stable kind: `reminder.due`, `action.failed`. */
  readonly type: string;
  readonly title: string;
  readonly body?: string | null;
  /** Routing only: deep link, entity ids. Never the content of a note. */
  readonly payload?: Record<string, string>;
  /** Target one device, or omit to reach all of the account's devices. */
  readonly deviceId?: string | null;
  /**
   * Caller-supplied and unique. This is what stops one reminder occurrence
   * producing two notifications when a job is retried.
   */
  readonly dedupeKey?: string | null;
  readonly urgent?: boolean;
}

export interface DispatchReport {
  readonly notificationId: string;
  readonly status: NotificationStatus;
  readonly attemptCount: number;
  readonly providerId: string | null;
  /** True when a transport took it. Not a claim that anybody saw it. */
  readonly accepted: boolean;
  readonly failureCode: string | null;
  readonly detail: string;
}

/**
 * Notifications.
 *
 * The distinction this service exists to keep is between **scheduled**,
 * **accepted** and **seen**, and it never collapses them:
 *
 * - `QUEUED` — a row exists. Nothing has been attempted.
 * - `SENT` — a transport accepted it. It has taken responsibility for
 *   trying; it has not reached a device and nobody has seen it.
 * - `UNDELIVERABLE` — no transport exists for this user's devices, so
 *   nothing was attempted. Recorded rather than quietly dropped.
 * - `READ` — a client said the person saw it. The only status that comes
 *   close to delivery, and only because the client reports it.
 *
 * There is deliberately no `DELIVERED`. We cannot observe it, so there is
 * nothing to name.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushRegistry,
    private readonly config: AppConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────── queueing

  /**
   * Creates a notification, or returns the one a dedupe key already names.
   *
   * The unique index on `dedupeKey` is the guarantee: a second call with the
   * same key cannot create a second row, so a retried job or a restarted
   * worker produces one notification. Returning the existing row rather
   * than failing is what makes the caller's retry harmless.
   */
  async queue(input: QueueNotificationInput): Promise<{ id: string; duplicate: boolean }> {
    const preferences = await this.preferencesFor(input.userId);

    // The user's own switch. A notification they turned off is not created
    // at all, rather than created and then not sent — there is nothing to
    // report on, and a row would imply we tried.
    if (!preferences.enabled || preferences.mutedTypes.includes(input.type)) {
      return { id: '', duplicate: false };
    }

    const data: Prisma.NotificationUncheckedCreateInput = {
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      channel: NotificationChannel.PUSH,
      type: input.type.slice(0, 60),
      title: input.title.slice(0, 200),
      body: input.body ?? null,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey ?? null,
      status: NotificationStatus.QUEUED,
    };

    if (!input.dedupeKey) {
      const created = await this.prisma.notification.create({ data, select: { id: true } });
      return { id: created.id, duplicate: false };
    }

    try {
      const created = await this.prisma.notification.create({ data, select: { id: true } });
      return { id: created.id, duplicate: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Scoped to the user, matching the constraint. Looking it up by
        // the key alone would be the leak the constraint exists to prevent.
        const existing = await this.prisma.notification.findFirst({
          where: { userId: input.userId, dedupeKey: input.dedupeKey },
          select: { id: true },
        });
        if (existing) return { id: existing.id, duplicate: true };
      }
      throw error;
    }
  }

  // ───────────────────────────────────────────────────────────── dispatch

  /**
   * Attempts delivery.
   *
   * Idempotent on purpose, because it runs from a job that may be retried:
   * a notification already `SENT` or `READ` is left alone and reported as
   * such. The attempt counter increments before the transport is called, so
   * a crash mid-send is visible as an attempt rather than as nothing.
   */
  async dispatch(notificationId: string): Promise<DispatchReport> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        userId: true,
        deviceId: true,
        type: true,
        title: true,
        body: true,
        payload: true,
        status: true,
        attemptCount: true,
      },
    });
    if (!notification) throw AppError.notFound('Notification');

    if (
      notification.status === NotificationStatus.SENT ||
      notification.status === NotificationStatus.READ
    ) {
      return {
        notificationId: notification.id,
        status: notification.status,
        attemptCount: notification.attemptCount,
        providerId: null,
        accepted: true,
        failureCode: null,
        detail: 'Already handed to a transport.',
      };
    }

    const targets = await this.targetsFor(notification.userId, notification.deviceId);

    if (targets.length === 0) {
      // No device has a push token. Recorded as undeliverable, which is
      // honest: nothing was attempted and nothing will be. The row still
      // exists, so the in-app list shows it when the user next looks.
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.UNDELIVERABLE,
          channel: NotificationChannel.IN_APP,
          failureCode: 'no_transport',
          failureReason: 'No device is registered for push notifications.',
        },
      });
      return {
        notificationId: notification.id,
        status: NotificationStatus.UNDELIVERABLE,
        attemptCount: notification.attemptCount,
        providerId: null,
        accepted: false,
        failureCode: 'no_transport',
        detail: 'No push transport for this account; it is available in-app.',
      };
    }

    const attempt = notification.attemptCount + 1;
    await this.prisma.notification.update({
      where: { id: notification.id },
      data: { status: NotificationStatus.SENDING, attemptCount: attempt },
    });

    const message = {
      title: notification.title,
      body: notification.body,
      data: {
        type: notification.type,
        notificationId: notification.id,
        ...(asStringRecord(notification.payload)),
      },
      // One notification per thing: a second reminder about the same
      // occurrence replaces the first on the lock screen.
      collapseKey: notification.type,
      urgent: notification.type.startsWith('reminder.'),
    };

    let accepted = false;
    let providerId: string | null = null;
    let providerRef: string | null = null;
    let lastError: PushError | null = null;

    for (const target of targets) {
      const provider = this.push.forPlatform(target.platform);
      if (!provider) continue;

      try {
        const result = await provider.send(
          message,
          { token: target.token, platform: target.platform },
          this.config.providers.push.timeoutMs,
        );
        accepted = true;
        providerId = provider.id;
        providerRef = result.providerRef;
        // One acceptance is enough: the account has been reached.
        break;
      } catch (error) {
        lastError = error instanceof PushError ? error : null;
        // The message is not logged; it is the user's own content.
        this.logger.warn(
          `Push to ${target.platform} via ${provider.id} failed (${lastError?.code ?? 'unknown'})`,
        );

        if (isTokenRejection(error)) {
          // A dead token should stop being tried. Cleared here rather than
          // left to fail on every future notification.
          await this.prisma.device
            .update({ where: { id: target.deviceId }, data: { pushToken: null } })
            .catch(() => undefined);
        }
      }
    }

    if (accepted) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          providerId,
          providerRef,
          failureCode: null,
          failureReason: null,
        },
      });
      return {
        notificationId: notification.id,
        status: NotificationStatus.SENT,
        attemptCount: attempt,
        providerId,
        accepted: true,
        failureCode: null,
        // Worded carefully, and this wording is asserted in the tests.
        detail: 'Accepted by a transport. Not confirmed as seen.',
      };
    }

    const failureCode = lastError?.code ?? 'unknown';
    const retryable = lastError?.retryable ?? false;

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: NotificationStatus.FAILED,
        failureCode,
        failureReason: retryable ? 'A transport was unavailable.' : 'A transport refused it.',
      },
    });

    // Re-thrown for a retryable failure, so the queue's backoff applies.
    // A permanent failure is recorded and not retried.
    if (retryable && lastError) throw lastError;

    return {
      notificationId: notification.id,
      status: NotificationStatus.FAILED,
      attemptCount: attempt,
      providerId: null,
      accepted: false,
      failureCode,
      detail: 'No transport accepted it.',
    };
  }

  // ───────────────────────────────────────────────────────────── reading

  /** This account's notifications, newest first. */
  async list(userId: string, query: PaginationQueryDto, unreadOnly = false) {
    const where = { userId, ...(unreadOnly ? { readAt: null } : {}) };

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        select: NOTIFICATION_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return new PageDto(items, new PageMetaDto(query.page, query.limit, total));
  }

  async unreadCount(userId: string): Promise<{ unread: number }> {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  /** Marks one as read. Another account's id reads as missing. */
  async markRead(userId: string, notificationId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date(), status: NotificationStatus.READ },
    });
    if (count === 0) {
      const exists = await this.prisma.notification.findFirst({
        where: { id: notificationId, userId },
        select: { id: true, readAt: true },
      });
      if (!exists) throw AppError.notFound('Notification');
      return { read: true, alreadyRead: true };
    }
    return { read: true, alreadyRead: false };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date(), status: NotificationStatus.READ },
    });
    return { read: count };
  }

  // ───────────────────────────────────────────────────────────── private

  /**
   * Devices that can actually be reached.
   *
   * A device with no push token is not a target: there is nothing to send
   * to. Including it would turn "the user has no push set up" into a
   * delivery failure, which is a different and less useful thing to record.
   */
  private async targetsFor(
    userId: string,
    deviceId: string | null,
  ): Promise<{ deviceId: string; token: string; platform: DevicePlatform }[]> {
    const devices = await this.prisma.device.findMany({
      where: {
        userId,
        revokedAt: null,
        pushToken: { not: null },
        ...(deviceId ? { id: deviceId } : {}),
      },
      select: { id: true, pushToken: true, platform: true },
      // Most recently seen first, so the device the user is actually using
      // is tried before one they have not opened in a month.
      orderBy: { lastSeenAt: { sort: 'desc', nulls: 'last' } },
      take: 10,
    });

    return devices
      .filter((d): d is typeof d & { pushToken: string } => Boolean(d.pushToken))
      .map((d) => ({ deviceId: d.id, token: d.pushToken, platform: d.platform }));
  }

  private async preferencesFor(userId: string) {
    const row = await this.prisma.userPreference.findUnique({
      where: { userId },
      select: { assistant: true },
    });
    return parseNotificationPreferences(row?.assistant);
  }
}

/** Payload values are strings on the wire; anything else is dropped. */
function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
    else if (typeof entry === 'number' || typeof entry === 'boolean') out[key] = String(entry);
  }
  return out;
}
