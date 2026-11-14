import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OccurrenceStatus, ReminderStatus } from '@prisma/client';
import { Worker, type Job } from 'bullmq';
import { AppConfigService } from '../config/app-config.module';
import { PrismaService } from '../database/prisma.service';
import { ActionExecutorService } from '../modules/actions/action-executor.service';
import { ConnectionsService } from '../modules/integrations/connections.service';
import { OAuthService } from '../modules/integrations/oauth.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { NotesService } from '../modules/notes/notes.service';
import { RemindersService, jobIdFor } from '../modules/reminders/reminders.service';
import { VoiceService } from '../modules/voice/voice.service';
import { VoiceSessionService } from '../modules/voice/voice-session.service';
import { nextOccurrence } from '../modules/reminders/time';
import { JOB, QUEUE } from './queue.constants';
import { QueueService } from './queue.service';

/** What a handler reports, so the log line says something useful. */
interface JobReport {
  readonly handled: string;
  readonly detail?: Record<string, number | string | boolean | null>;
}

/**
 * The background workers.
 *
 * Every handler here is **idempotent**, because a queue gives at-least-once
 * delivery: a worker that dies after doing the work but before
 * acknowledging it will be handed the same job again. So each one either
 * re-reads its subject and finds the work already done, or relies on a
 * database constraint to make the second attempt a no-op.
 *
 * Nothing here trusts its payload. A job carries ids; the handler loads the
 * current state. A reminder may have been completed, snoozed, rescheduled
 * or deleted between the job being enqueued and running, and the payload
 * cannot know that.
 *
 * Shutdown closes each worker, which lets BullMQ finish the job in flight
 * and return anything unstarted to the queue rather than losing it.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private workers: Worker[] = [];

  constructor(
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly reminders: RemindersService,
    private readonly notes: NotesService,
    private readonly notifications: NotificationsService,
    private readonly actions: ActionExecutorService,
    private readonly voice: VoiceService,
    private readonly voiceSessions: VoiceSessionService,
    private readonly connections: ConnectionsService,
    private readonly oauth: OAuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = this.queue.redis;
    if (!connection) {
      // Said once, plainly. Without this the only symptom would be
      // reminders that never arrive.
      this.logger.warn(
        'No durable queue, so no background work runs: reminders will not be ' +
          'delivered and cleanup will not happen. Set REDIS_URL to enable them.',
      );
      return;
    }

    this.workers = [
      new Worker(QUEUE.reminders, (job) => this.handle(job), {
        connection,
        // Modest: these handlers are short and mostly database work, and a
        // high number would just contend on the connection pool.
        concurrency: 5,
      }),
      new Worker(QUEUE.notifications, (job) => this.handle(job), {
        connection,
        concurrency: 5,
      }),
      new Worker(QUEUE.maintenance, (job) => this.handle(job), {
        connection,
        // One at a time: these sweep whole tables and there is no reason
        // for two to run together.
        concurrency: 1,
      }),
    ];

    for (const worker of this.workers) {
      worker.on('failed', (job, error) => {
        // Logged with the attempt count, so a transient failure that
        // eventually succeeded reads differently from one that gave up.
        this.logger.warn(
          `Job ${job?.name ?? 'unknown'} (${job?.id ?? '-'}) failed on attempt ` +
            `${job?.attemptsMade ?? 0}: ${error.message}`,
        );
      });
      worker.on('error', (error) => this.logger.warn(`Worker: ${error.message}`));
    }

    const installed = this.config.providers.jobs.maintenanceEnabled
      ? await this.queue.installMaintenanceSchedule()
      : 0;

    this.logger.log(
      `Background workers started (${this.workers.length} queues, ${installed} scheduled tasks).` +
        (this.config.providers.jobs.maintenanceEnabled
          ? ''
          : ' Maintenance scheduling is turned off for this instance.'),
    );
  }

  /**
   * Graceful shutdown.
   *
   * `close()` waits for the job in flight. Without that a deploy mid-job
   * would leave an occurrence marked SCHEDULED with no job to fire it —
   * recoverable by the reconciliation sweep, but a needless round trip
   * through a broken state.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.workers.map((worker) =>
        worker.close().catch((error: unknown) => {
          this.logger.warn(`Closing worker: ${describe(error)}`);
        }),
      ),
    );
    this.workers = [];
  }

  // ───────────────────────────────────────────────────────────── dispatch

  /** Routes a job by name. An unknown name is an error, not a silent no-op. */
  private async handle(job: Job): Promise<JobReport> {
    switch (job.name) {
      case JOB.deliverReminder:
        return this.deliverReminder(job);
      case JOB.sendNotification:
        return this.sendNotification(job);

      case JOB.reconcileReminders:
        return { handled: job.name, detail: { repaired: await this.reminders.reconcile() } };
      case JOB.reconcileActions:
        return { handled: job.name, detail: { reconciled: await this.actions.reconcileStale() } };
      case JOB.refreshIntegrations: {
        const report = await this.connections.refreshExpiring();
        return { handled: job.name, detail: { ...report } };
      }
      case JOB.purgeOauthStates:
        return { handled: job.name, detail: { purged: await this.oauth.purgeStates() } };

      case JOB.expireStale:
        return this.expireStale(job.name);
      case JOB.cleanupAudio:
        return this.cleanupAudio(job.name);
      case JOB.cleanupSessions:
        return this.cleanupSessions(job.name);
      case JOB.purgeDeleted:
        return this.purgeDeleted(job.name);

      default:
        throw new Error(`No handler for job "${job.name}"`);
    }
  }

  // ───────────────────────────────────────────────────── reminder delivery

  /**
   * Fires one occurrence of a reminder.
   *
   * The deduplication is the `@@unique([reminderId, scheduledFor])`
   * constraint on the occurrence row, created before anything is notified.
   * A retried job, a duplicated enqueue or a restart all collide on it, so
   * one instant produces one notification however many times this runs.
   *
   * The reminder is re-read rather than trusted from the payload: it may
   * have been completed, snoozed, rescheduled or deleted since.
   */
  private async deliverReminder(job: Job): Promise<JobReport> {
    const { reminderId, scheduledFor } = job.data as {
      reminderId?: string;
      scheduledFor?: string;
    };
    if (!reminderId || !scheduledFor) throw new Error('Malformed reminder job payload.');

    const instant = new Date(scheduledFor);

    const reminder = await this.prisma.reminder.findUnique({
      where: { id: reminderId },
      select: {
        id: true,
        userId: true,
        text: true,
        dueAt: true,
        timezone: true,
        rrule: true,
        status: true,
        deletedAt: true,
      },
    });

    if (!reminder || reminder.deletedAt) {
      return { handled: job.name, detail: { skipped: 'deleted' } };
    }
    if (reminder.status === ReminderStatus.DONE || reminder.status === ReminderStatus.CANCELLED) {
      return { handled: job.name, detail: { skipped: reminder.status } };
    }
    // Rescheduled since this job was created. The job for the new time is
    // what will fire; this one does nothing.
    if (reminder.dueAt.getTime() !== instant.getTime()) {
      return { handled: job.name, detail: { skipped: 'rescheduled' } };
    }

    // Claimed by the constraint, before anything is notified.
    let occurrenceId: string;
    try {
      const occurrence = await this.prisma.reminderOccurrence.create({
        data: {
          reminderId: reminder.id,
          userId: reminder.userId,
          scheduledFor: instant,
          status: OccurrenceStatus.SCHEDULED,
        },
        select: { id: true },
      });
      occurrenceId = occurrence.id;
    } catch {
      // Already fired. This is the duplicate case, and it is the normal
      // outcome of a retry rather than an error.
      return { handled: job.name, detail: { skipped: 'already-fired' } };
    }

    const queued = await this.notifications.queue({
      userId: reminder.userId,
      type: 'reminder.due',
      title: reminder.text.slice(0, 200),
      body: null,
      payload: { reminderId: reminder.id, occurrenceId },
      // The same key for the same occurrence, so a retry cannot produce a
      // second notification even if the occurrence row were somehow lost.
      dedupeKey: `reminder:${reminder.id}:${instant.getTime()}`,
      urgent: true,
    });

    if (!queued.id) {
      // The user has notifications off for this type. Recorded as skipped,
      // which is different from failed and from delivered.
      await this.prisma.reminderOccurrence.update({
        where: { id: occurrenceId },
        data: { status: OccurrenceStatus.SKIPPED, failureCode: 'notifications_off' },
      });
      await this.advance(reminder);
      return { handled: job.name, detail: { skipped: 'notifications-off' } };
    }

    // Dispatched on its own queue, so a slow transport cannot delay the
    // next reminder's firing.
    await this.queue.enqueue(
      QUEUE.notifications,
      JOB.sendNotification,
      { notificationId: queued.id, occurrenceId },
      `notify:${queued.id}`,
    );

    await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: { firedAt: new Date(), status: ReminderStatus.FIRED },
    });
    await this.prisma.reminderOccurrence.update({
      where: { id: occurrenceId },
      data: { firedAt: new Date(), notificationId: queued.id },
    });

    await this.advance(reminder);

    return {
      handled: job.name,
      detail: { reminderId: reminder.id, notificationId: queued.id, recurring: Boolean(reminder.rrule) },
    };
  }

  /**
   * Moves a recurring reminder to its next occurrence.
   *
   * Computed from the rule and the zone, so the wall-clock hour survives a
   * daylight-saving change rather than drifting by an hour for half the
   * year. A one-off reminder stays FIRED and is simply done.
   */
  private async advance(reminder: {
    id: string;
    dueAt: Date;
    timezone: string;
    rrule: string | null;
  }): Promise<void> {
    if (!reminder.rrule) return;

    const next = nextOccurrence(reminder.rrule, reminder.dueAt, reminder.timezone, reminder.dueAt);
    if (!next) {
      // The series has ended.
      await this.prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: ReminderStatus.DONE, completedAt: new Date() },
      });
      return;
    }

    await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        dueAt: next,
        status: ReminderStatus.SCHEDULED,
        firedAt: null,
        jobId: null,
      },
    });

    await this.queue.scheduleAt(
      QUEUE.reminders,
      JOB.deliverReminder,
      { reminderId: reminder.id, scheduledFor: next.toISOString() },
      next,
      jobIdFor(reminder.id, next),
    );
    await this.prisma.reminder.update({
      where: { id: reminder.id },
      data: { jobId: jobIdFor(reminder.id, next) },
    });
  }

  /**
   * Hands one notification to a transport.
   *
   * `NotificationsService.dispatch` is itself idempotent — an already-sent
   * notification is left alone — so a retry is safe. A retryable failure is
   * re-thrown so the queue's backoff applies; a permanent one is recorded
   * and not retried.
   */
  private async sendNotification(job: Job): Promise<JobReport> {
    const { notificationId, occurrenceId } = job.data as {
      notificationId?: string;
      occurrenceId?: string;
    };
    if (!notificationId) throw new Error('Malformed notification job payload.');

    const report = await this.notifications.dispatch(notificationId);

    if (occurrenceId) {
      await this.prisma.reminderOccurrence
        .update({
          where: { id: occurrenceId },
          data: {
            // DELIVERED here means a transport accepted it — the enum's own
            // comment says so. It is not a claim that anybody saw it.
            status: report.accepted ? OccurrenceStatus.DELIVERED : OccurrenceStatus.FAILED,
            failureCode: report.failureCode,
          },
        })
        .catch(() => undefined);
    }

    return {
      handled: job.name,
      detail: { status: report.status, accepted: report.accepted, attempt: report.attemptCount },
    };
  }

  // ─────────────────────────────────────────────────────────────── cleanup

  private async expireStale(name: string): Promise<JobReport> {
    const [voiceSessions, pendingActions] = await Promise.all([
      this.voiceSessions.expireOverdue(),
      this.actions.expireOverdue(),
    ]);
    return { handled: name, detail: { voiceSessions, pendingActions } };
  }

  private async cleanupAudio(name: string): Promise<JobReport> {
    const swept = await this.voice.applyAudioRetention();
    return { handled: name, detail: { rows: swept.rows, orphans: swept.orphans } };
  }

  /**
   * Closes sessions whose refresh tokens have all expired.
   *
   * A session with no live token cannot be refreshed, so leaving it open
   * only makes the device list misleading.
   */
  private async cleanupSessions(name: string): Promise<JobReport> {
    // Refresh tokens are kept for a week past expiry rather than deleted at
    // expiry: presenting a rotated token is how token theft is detected, and
    // deleting the evidence immediately would turn a detectable replay into
    // an ordinary failed login.
    const { count: purgedTokens } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
    });

    const { count } = await this.prisma.session.updateMany({
      where: {
        endedAt: null,
        refreshTokens: { none: { revokedAt: null, expiresAt: { gt: new Date() } } },
        // Only sessions old enough that a client is not mid-login.
        startedAt: { lt: new Date(Date.now() - 86_400_000) },
      },
      data: { endedAt: new Date() },
    });

    return { handled: name, detail: { purgedTokens, closedSessions: count } };
  }

  /**
   * Removes soft-deleted records past the retention window.
   *
   * The window is also the longest a device may be offline and still learn
   * that something was deleted: purge sooner and a device returning after a
   * fortnight would silently keep a note the user removed. That is why this
   * runs every six hours against a window measured in days, rather than
   * aggressively.
   */
  private async purgeDeleted(name: string): Promise<JobReport> {
    const days = this.config.providers.productivity.tombstoneDays;
    const [notes, reminders] = await Promise.all([
      this.notes.purgeDeleted(days),
      this.reminders.purgeDeleted(days),
    ]);
    return { handled: name, detail: { notes, reminders, retainDays: days } };
  }

  // ──────────────────────────────────────────────────────────── monitoring

  /** Queue depths and worker state, for the readiness probe. */
  async inspect() {
    return {
      available: this.queue.available,
      workers: this.workers.length,
      running: this.workers.filter((w) => w.isRunning()).length,
      counts: await this.queue.counts(),
    };
  }

  /**
   * Runs one maintenance job now.
   *
   * For tests and for an operator who does not want to wait for the next
   * interval. The handlers are idempotent, so running one early is safe.
   */
  async runNow(name: string): Promise<JobReport> {
    return this.handle({ name, data: {} } as Job);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
