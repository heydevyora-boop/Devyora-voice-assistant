import { Injectable, Logger } from '@nestjs/common';
import { OccurrenceStatus, ReminderStatus, type Prisma } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config.module';
import { PageDto, PageMetaDto, type PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import { JOB, QUEUE } from '../../jobs/queue.constants';
import { QueueService } from '../../jobs/queue.service';
import {
  assertSchedulable,
  fromInstant,
  isValidTimezone,
  nextOccurrence,
  parseRecurrence,
  toInstant,
} from './time';
import type { ListRemindersQueryDto } from './dto/reminders.dto';

const REMINDER_SELECT = {
  id: true,
  text: true,
  dueAt: true,
  timezone: true,
  rrule: true,
  status: true,
  jobId: true,
  firedAt: true,
  completedAt: true,
  snoozedUntil: true,
  snoozeCount: true,
  clientId: true,
  version: true,
  updatedByDeviceId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

type ReminderRow = Prisma.ReminderGetPayload<{ select: typeof REMINDER_SELECT }>;

export interface ReminderContext {
  readonly userId: string;
  readonly deviceId: string | null;
}

export interface WriteReminderInput {
  readonly text: string;
  /**
   * Either a wall-clock reading (`2026-11-10T08:00`) interpreted in the
   * reminder's zone, or an absolute instant with an offset. Both are
   * accepted because the AI layer produces the second and a date picker
   * produces the first.
   */
  readonly dueAt: string;
  readonly timezone?: string | null;
  readonly rrule?: string | null;
  readonly clientId?: string | null;
}

/** A reminder as a client sees it, with the wall-clock reading worked out. */
export interface ReminderView {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly local: { local: string; display: string; zone: string; offsetMinutes: number };
  readonly timezone: string;
  readonly rrule: string | null;
  readonly recurring: boolean;
  readonly status: ReminderStatus;
  /**
   * Whether anything will actually fire. False when durable scheduling is
   * unavailable — the reminder is stored, and the user is told it will not
   * alert them.
   */
  readonly scheduled: boolean;
  readonly firedAt: string | null;
  readonly completedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly snoozeCount: number;
  readonly version: number;
  readonly clientId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  /** Set when a daylight-saving boundary moved the time that was asked for. */
  readonly adjusted: { reason: string; requested: string; resolved: string; detail: string } | null;
}

/**
 * Reminders.
 *
 * Three things worth knowing before reading the rest.
 *
 * **The instant and the zone are both stored.** `dueAt` is UTC; `timezone`
 * says what wall-clock time the user meant. A recurring reminder needs both,
 * because "every Monday at 9am" is a statement about the clock on the wall
 * and that is a different instant either side of a daylight-saving change.
 *
 * **Scheduling is durable or absent, never pretended.** A reminder is
 * enqueued in Redis and the row keeps the job id. With no Redis the row is
 * still written, `jobId` stays null, and `scheduled` is false — which is
 * what the response and the assistant both say. Nothing here uses a timer.
 *
 * **Postgres is the source of truth.** The job is a prompt to act. If the
 * enqueue fails or Redis loses the job, the reconciliation sweep finds the
 * row and enqueues it again, which is the only way two systems can be made
 * to agree.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: AppConfigService,
  ) {}

  // ───────────────────────────────────────────────────────────────── write

  async create(context: ReminderContext, input: WriteReminderInput): Promise<ReminderView> {
    const zone = await this.resolveZone(context.userId, input.timezone);
    const resolved = toInstant(input.dueAt, zone);

    if (!resolved.ok) throw AppError.validation(resolved.detail);
    assertSchedulable(resolved.instant);

    // The rule is parsed before anything is written, so an unusable rule is
    // a rejected request rather than a stored reminder that never fires.
    const recurrence = input.rrule
      ? parseRecurrence(input.rrule, resolved.instant, zone)
      : null;

    const data = {
      userId: context.userId,
      text: input.text,
      dueAt: resolved.instant,
      timezone: zone,
      rrule: recurrence?.rrule ?? null,
      status: ReminderStatus.SCHEDULED,
      updatedByDeviceId: context.deviceId,
    };

    const reminder = input.clientId
      ? await this.prisma.reminder.upsert({
          where: { userId_clientId: { userId: context.userId, clientId: input.clientId } },
          create: { ...data, clientId: input.clientId },
          update: {
            text: data.text,
            dueAt: data.dueAt,
            timezone: data.timezone,
            rrule: data.rrule,
            status: ReminderStatus.SCHEDULED,
            completedAt: null,
            deletedAt: null,
            updatedByDeviceId: context.deviceId,
            version: { increment: 1 },
          },
          select: REMINDER_SELECT,
        })
      : await this.prisma.reminder.create({ data, select: REMINDER_SELECT });

    const scheduled = await this.schedule(reminder);
    return this.toView(scheduled, resolved.adjusted);
  }

  /**
   * Updates a reminder, refusing a change built on a stale version.
   *
   * Rescheduling cancels the previous job before enqueueing a new one. A job
   * already running cannot be cancelled, which is why the handler re-reads
   * the reminder rather than trusting its payload.
   */
  async update(
    context: ReminderContext,
    reminderId: string,
    input: Partial<WriteReminderInput>,
    expectedVersion?: number,
  ): Promise<ReminderView> {
    const existing = await this.requireOwned(context.userId, reminderId);

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw conflict(existing, expectedVersion);
    }
    if (existing.status === ReminderStatus.DONE) {
      throw AppError.conflict('That reminder is already done.');
    }

    const zone = input.timezone
      ? await this.resolveZone(context.userId, input.timezone)
      : existing.timezone;

    let dueAt = existing.dueAt;
    let adjusted: ReminderView['adjusted'] = null;

    if (input.dueAt) {
      const resolved = toInstant(input.dueAt, zone);
      if (!resolved.ok) throw AppError.validation(resolved.detail);
      assertSchedulable(resolved.instant);
      dueAt = resolved.instant;
      adjusted = resolved.adjusted;
    }

    const recurrence =
      input.rrule === undefined
        ? null
        : input.rrule
          ? parseRecurrence(input.rrule, dueAt, zone)
          : null;

    const { count } = await this.prisma.reminder.updateMany({
      where: { id: reminderId, userId: context.userId, version: existing.version },
      data: {
        ...(input.text !== undefined ? { text: input.text } : {}),
        dueAt,
        timezone: zone,
        ...(input.rrule !== undefined ? { rrule: recurrence?.rrule ?? null } : {}),
        // A rescheduled reminder is no longer snoozed or fired.
        status: ReminderStatus.SCHEDULED,
        snoozedUntil: null,
        firedAt: null,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
    });

    if (count === 0) {
      const current = await this.requireOwned(context.userId, reminderId);
      throw conflict(current, expectedVersion ?? existing.version);
    }

    await this.unschedule(existing.jobId);
    const updated = await this.requireOwned(context.userId, reminderId);
    return this.toView(await this.schedule(updated), adjusted);
  }

  /** Marks a reminder done. A recurring one keeps its schedule. */
  async complete(context: ReminderContext, reminderId: string): Promise<ReminderView> {
    const existing = await this.requireOwned(context.userId, reminderId);

    if (existing.rrule) {
      // Completing one occurrence of a recurring reminder does not end the
      // series. The next occurrence is computed and scheduled.
      //
      // Measured from the occurrence being completed, not from now: a
      // reminder due next month that the user ticks off today should move
      // to the month after, not stay where it is because "the next
      // occurrence after now" is the one just completed.
      const next = nextOccurrence(
        existing.rrule,
        existing.dueAt,
        existing.timezone,
        existing.dueAt,
      );
      if (next) {
        await this.prisma.reminder.update({
          where: { id: reminderId },
          data: {
            dueAt: next,
            status: ReminderStatus.SCHEDULED,
            firedAt: null,
            snoozedUntil: null,
            updatedByDeviceId: context.deviceId,
            version: { increment: 1 },
          },
        });
        await this.unschedule(existing.jobId);
        const advanced = await this.requireOwned(context.userId, reminderId);
        return this.toView(await this.schedule(advanced), null);
      }
      // The series has ended.
    }

    await this.unschedule(existing.jobId);
    await this.prisma.reminder.update({
      where: { id: reminderId },
      data: {
        status: ReminderStatus.DONE,
        completedAt: new Date(),
        // Cleared, so `scheduled` reads false. A row still naming a job
        // that has been removed would tell the user an alarm is set when
        // it is not.
        jobId: null,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
    });

    return this.toView(await this.requireOwned(context.userId, reminderId), null);
  }

  /**
   * Pushes a reminder back.
   *
   * The new time is computed from *now*, not from the original due time: a
   * user pressing snooze means "not for another ten minutes", not "ten
   * minutes after the time I already missed".
   */
  async snooze(
    context: ReminderContext,
    reminderId: string,
    minutes: number,
  ): Promise<ReminderView> {
    const existing = await this.requireOwned(context.userId, reminderId);

    if (existing.status === ReminderStatus.DONE) {
      throw AppError.conflict('That reminder is already done.');
    }

    const until = new Date(Date.now() + minutes * 60_000);
    assertSchedulable(until);

    await this.prisma.reminder.update({
      where: { id: reminderId },
      data: {
        dueAt: until,
        snoozedUntil: until,
        snoozeCount: { increment: 1 },
        status: ReminderStatus.SNOOZED,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
    });

    await this.unschedule(existing.jobId);
    return this.toView(await this.schedule(await this.requireOwned(context.userId, reminderId)), null);
  }

  async remove(context: ReminderContext, reminderId: string, expectedVersion?: number) {
    const existing = await this.requireOwned(context.userId, reminderId);

    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw conflict(existing, expectedVersion);
    }

    const now = new Date();
    await this.unschedule(existing.jobId);
    await this.prisma.reminder.updateMany({
      where: { id: reminderId, userId: context.userId, version: existing.version },
      data: {
        deletedAt: now,
        status: ReminderStatus.CANCELLED,
        jobId: null,
        updatedByDeviceId: context.deviceId,
        version: { increment: 1 },
      },
    });

    return { deleted: true, deletedAt: now.toISOString() };
  }

  // ───────────────────────────────────────────────────────────────── read

  async requireOwned(userId: string, reminderId: string, options: { includeDeleted?: boolean } = {}) {
    const reminder = await this.prisma.reminder.findFirst({
      where: {
        id: reminderId,
        userId,
        ...(options.includeDeleted ? {} : { deletedAt: null }),
      },
      select: REMINDER_SELECT,
    });
    if (!reminder) throw AppError.notFound('Reminder');
    return reminder;
  }

  async get(userId: string, reminderId: string): Promise<ReminderView> {
    return this.toView(await this.requireOwned(userId, reminderId), null);
  }

  async list(userId: string, query: ListRemindersQueryDto) {
    const where: Prisma.ReminderWhereInput = {
      userId,
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            dueAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q ? { text: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.reminder.findMany({
        where,
        select: REMINDER_SELECT,
        orderBy: { dueAt: query.order ?? 'asc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.reminder.count({ where }),
    ]);

    return new PageDto(
      items.map((r) => this.toView(r, null)),
      new PageMetaDto(query.page, query.limit, total),
    );
  }

  /** Reminders due between now and a horizon. The home-screen query. */
  async upcoming(userId: string, days?: number): Promise<ReminderView[]> {
    const horizon = new Date(
      Date.now() + (days ?? this.config.providers.productivity.upcomingDays) * 86_400_000,
    );

    const rows = await this.prisma.reminder.findMany({
      where: {
        userId,
        deletedAt: null,
        status: { in: [ReminderStatus.SCHEDULED, ReminderStatus.SNOOZED] },
        dueAt: { lte: horizon },
      },
      select: REMINDER_SELECT,
      orderBy: { dueAt: 'asc' },
      take: 100,
    });

    return rows.map((r) => this.toView(r, null));
  }

  /**
   * What actually happened.
   *
   * Occurrences, not reminders: a weekly reminder is one row, and "did
   * Monday's go out?" is a question about an occurrence. Each one carries
   * the notification it produced, so the answer chains through to what the
   * transport said.
   */
  async history(userId: string, query: PaginationQueryDto) {
    const where = { userId };

    const [items, total] = await Promise.all([
      this.prisma.reminderOccurrence.findMany({
        where,
        select: {
          id: true,
          reminderId: true,
          scheduledFor: true,
          status: true,
          firedAt: true,
          notificationId: true,
          failureCode: true,
          createdAt: true,
          reminder: { select: { text: true, timezone: true } },
        },
        orderBy: { scheduledFor: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.reminderOccurrence.count({ where }),
    ]);

    return new PageDto(
      items.map((o) => ({
        id: o.id,
        reminderId: o.reminderId,
        text: o.reminder.text,
        scheduledFor: o.scheduledFor.toISOString(),
        local: fromInstant(o.scheduledFor, o.reminder.timezone),
        status: o.status,
        firedAt: o.firedAt?.toISOString() ?? null,
        notificationId: o.notificationId,
        failureCode: o.failureCode,
      })),
      new PageMetaDto(query.page, query.limit, total),
    );
  }

  // ─────────────────────────────────────────────────────────── scheduling

  /**
   * Enqueues the next firing and records the job id.
   *
   * The job id is derived from the reminder and the instant, not random.
   * That is what makes a repeated enqueue harmless: BullMQ will not hold
   * two jobs with the same id, so a reconciliation sweep racing a create
   * produces one job rather than two firings.
   */
  async schedule(reminder: ReminderRow): Promise<ReminderRow> {
    if (
      reminder.deletedAt ||
      reminder.status === ReminderStatus.DONE ||
      reminder.status === ReminderStatus.CANCELLED
    ) {
      return reminder;
    }

    const jobId = jobIdFor(reminder.id, reminder.dueAt);
    const enqueued = await this.queue.scheduleAt(
      QUEUE.reminders,
      JOB.deliverReminder,
      { reminderId: reminder.id, scheduledFor: reminder.dueAt.toISOString() },
      reminder.dueAt,
      jobId,
    );

    if (!enqueued) {
      // Durable scheduling is unavailable, or the enqueue failed. The row
      // stays, `jobId` stays null, and `scheduled` will read false — the
      // user is told rather than left expecting an alarm.
      if (reminder.jobId !== null) {
        await this.prisma.reminder.update({
          where: { id: reminder.id },
          data: { jobId: null },
        });
        return { ...reminder, jobId: null };
      }
      return reminder;
    }

    await this.prisma.reminder.update({ where: { id: reminder.id }, data: { jobId: enqueued } });
    return { ...reminder, jobId: enqueued };
  }

  private async unschedule(jobId: string | null): Promise<void> {
    if (jobId) await this.queue.cancel(QUEUE.reminders, jobId);
  }

  /**
   * Finds reminders that should be scheduled and are not.
   *
   * This is the bridge between two systems that cannot be written to
   * atomically. A reminder row exists in Postgres; its job lives in Redis.
   * A crash between the two, a Redis flush, or a restart after a period
   * with no Redis all leave a row whose job is missing — and without this,
   * the reminder would simply never fire.
   *
   * Run from `JOB.reconcileReminders` every minute. Idempotent: the derived
   * job id means re-enqueueing something already queued is a no-op.
   */
  async reconcile(horizonMs = 3_600_000, now = new Date()): Promise<number> {
    if (!this.queue.available) return 0;

    const due = await this.prisma.reminder.findMany({
      where: {
        deletedAt: null,
        status: { in: [ReminderStatus.SCHEDULED, ReminderStatus.SNOOZED] },
        dueAt: { lte: new Date(now.getTime() + horizonMs) },
      },
      select: REMINDER_SELECT,
      take: 500,
      orderBy: { dueAt: 'asc' },
    });

    let repaired = 0;
    for (const reminder of due) {
      const expected = jobIdFor(reminder.id, reminder.dueAt);

      // Either no job id, a stale one from a previous time, or an id whose
      // job is no longer in Redis.
      const intact =
        reminder.jobId === expected && (await this.queue.findJob(QUEUE.reminders, expected));
      if (intact) continue;

      await this.schedule(reminder);
      repaired += 1;
    }

    if (repaired > 0) {
      this.logger.warn(`Re-scheduled ${repaired} reminder(s) whose job was missing.`);
    }
    return repaired;
  }

  /** Permanently removes reminders deleted past the retention window. */
  async purgeDeleted(retainDays: number, now = new Date()): Promise<number> {
    if (retainDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retainDays * 86_400_000);

    const { count } = await this.prisma.reminder.deleteMany({
      where: { deletedAt: { not: null, lt: cutoff } },
    });
    return count;
  }

  // ───────────────────────────────────────────────────────────── private

  /**
   * The zone to use.
   *
   * A client may state one; otherwise the account's own is used, and the
   * configured default only if the account has none. An invalid zone is
   * rejected rather than quietly replaced — a reminder in the wrong zone is
   * a reminder at the wrong time.
   */
  private async resolveZone(userId: string, requested?: string | null): Promise<string> {
    if (requested) {
      if (!isValidTimezone(requested)) {
        throw AppError.validation(`"${requested}" is not a known time zone.`);
      }
      return requested;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });

    const zone = user?.timezone ?? this.config.providers.productivity.defaultTimezone;
    return isValidTimezone(zone) ? zone : 'UTC';
  }

  private toView(reminder: ReminderRow, adjusted: ReminderView['adjusted']): ReminderView {
    return {
      id: reminder.id,
      text: reminder.text,
      dueAt: reminder.dueAt.toISOString(),
      local: fromInstant(reminder.dueAt, reminder.timezone),
      timezone: reminder.timezone,
      rrule: reminder.rrule,
      recurring: reminder.rrule !== null,
      status: reminder.status,
      // Derived from the job id, not asserted. A reminder with no job will
      // not fire, and this is how the user finds out.
      scheduled: reminder.jobId !== null,
      firedAt: reminder.firedAt?.toISOString() ?? null,
      completedAt: reminder.completedAt?.toISOString() ?? null,
      snoozedUntil: reminder.snoozedUntil?.toISOString() ?? null,
      snoozeCount: reminder.snoozeCount,
      version: reminder.version,
      clientId: reminder.clientId,
      createdAt: reminder.createdAt.toISOString(),
      updatedAt: reminder.updatedAt.toISOString(),
      deletedAt: reminder.deletedAt?.toISOString() ?? null,
      adjusted,
    };
  }
}

/**
 * The job id for one firing.
 *
 * Derived from the reminder and the instant, so it is stable across
 * processes and restarts — which is what makes BullMQ's own
 * one-job-per-id rule into our deduplication guarantee.
 */
export function jobIdFor(reminderId: string, dueAt: Date): string {
  return `reminder:${reminderId}:${dueAt.getTime()}`;
}

/** Status values an occurrence may end in. Exported for the worker. */
export const OCCURRENCE_TERMINAL: readonly OccurrenceStatus[] = [
  OccurrenceStatus.DELIVERED,
  OccurrenceStatus.FAILED,
  OccurrenceStatus.SKIPPED,
  OccurrenceStatus.CANCELLED,
];

function conflict(current: ReminderRow, expectedVersion: number): AppError {
  return new AppError(
    'CONFLICT',
    'That reminder changed on another device. Nothing was overwritten.',
    409,
    [{ field: 'version', message: `expected ${expectedVersion}, stored ${current.version}` }],
  );
}
