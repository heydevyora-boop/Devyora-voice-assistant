import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.module';
import { MAINTENANCE_SCHEDULE, QUEUE, RETRY, type JobName } from './queue.constants';

/**
 * Durable scheduling.
 *
 * BullMQ over Redis, which survives a process restart — a delayed job lives
 * in Redis, not in a `setTimeout` that a deploy throws away. That is the
 * whole reason this layer exists, and the reason nothing in this codebase
 * schedules a reminder with a timer.
 *
 * **Redis is optional, and its absence is reported rather than hidden.**
 * With no `REDIS_URL` the queue is unavailable: `schedule` returns null, the
 * reminder is still stored, and its `jobId` stays null — which is exactly
 * what makes `reminders.create` tell the user "saved, but it will not alert
 * you yet". A queue that pretended to accept work it could not hold would
 * be worse than one that says it cannot.
 *
 * **Postgres remains the source of truth.** A job is a prompt to act, not
 * the record of what is scheduled; the reminder row is. That matters because
 * Redis and Postgres are two systems and a crash between writing the row and
 * enqueueing the job would otherwise lose the reminder. The reconciliation
 * sweep closes that gap — see `JOB.reconcileReminders`.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly url: string | undefined;

  private connection: Redis | null = null;
  private queues = new Map<string, Queue>();
  private closing = false;

  constructor(config: AppConfigService) {
    this.url = config.providers.redisUrl;
  }

  /** Whether durable scheduling is actually available. */
  get available(): boolean {
    return this.connection !== null && !this.closing;
  }

  async onModuleInit(): Promise<void> {
    if (!this.url) {
      this.logger.warn(
        'No REDIS_URL, so there is no durable scheduling. Reminders will be stored ' +
          'but not delivered, and the readiness probe reports it.',
      );
      return;
    }

    try {
      this.connection = new Redis(this.url, {
        // BullMQ requires this: a blocking command must not be retried a
        // fixed number of times and then give up.
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        // Fail fast at startup rather than queueing commands against a
        // Redis that is not there.
        lazyConnect: true,
        connectTimeout: 5_000,
      });

      this.connection.on('error', (error) => {
        // Logged once per distinct problem by ioredis's own throttling;
        // never thrown, because a Redis blip must not take the API down.
        this.logger.warn(`Redis: ${error.message}`);
      });

      await this.connection.connect();
      await this.connection.ping();

      this.logger.log('Durable scheduling is available.');
    } catch (error) {
      this.logger.error(
        `Could not reach Redis, so there is no durable scheduling: ${describe(error)}`,
      );
      await this.connection?.quit().catch(() => undefined);
      this.connection = null;
    }
  }

  /**
   * Shuts down without dropping work.
   *
   * Queues are closed, which lets BullMQ finish its in-flight commands, and
   * the connection goes last. Workers close themselves — see `JobsService`.
   */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;

    for (const [name, queue] of this.queues) {
      await queue.close().catch((error: unknown) => {
        this.logger.warn(`Closing queue ${name}: ${describe(error)}`);
      });
    }
    this.queues.clear();

    if (this.connection) {
      await this.connection.quit().catch(() => undefined);
      this.connection = null;
    }
  }

  /** The ioredis connection, for the workers. Null when unavailable. */
  get redis(): Redis | null {
    return this.connection;
  }

  /** A queue, created on first use. Null when scheduling is unavailable. */
  queue(name: string): Queue | null {
    if (!this.available) return null;

    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, {
      connection: this.connection!,
      defaultJobOptions: RETRY,
    });
    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Enqueues a job to run at an instant.
   *
   * `jobId` is the deduplication guarantee: BullMQ will not hold two jobs
   * with the same id in one queue, so an enqueue that happens twice — a
   * retry, a reconciliation sweep racing a create — produces one job. The
   * caller chooses an id derived from what the job is *for*, not a random
   * one, which is what makes that work.
   */
  async scheduleAt(
    queueName: string,
    jobName: JobName,
    payload: Record<string, unknown>,
    runAt: Date,
    jobId: string,
  ): Promise<string | null> {
    const queue = this.queue(queueName);
    if (!queue) return null;

    const delay = Math.max(0, runAt.getTime() - Date.now());

    try {
      const job = await queue.add(jobName, payload, { ...RETRY, delay, jobId });
      return job.id ?? jobId;
    } catch (error) {
      // A failed enqueue leaves the domain row in place with no job id,
      // which the reconciliation sweep will find. Reported, not swallowed.
      this.logger.error(`Could not enqueue ${jobName} (${jobId}): ${describe(error)}`);
      return null;
    }
  }

  /** Enqueues a job to run now. */
  async enqueue(
    queueName: string,
    jobName: JobName,
    payload: Record<string, unknown>,
    jobId?: string,
  ): Promise<string | null> {
    const queue = this.queue(queueName);
    if (!queue) return null;

    try {
      const job = await queue.add(jobName, payload, { ...RETRY, ...(jobId ? { jobId } : {}) });
      return job.id ?? null;
    } catch (error) {
      this.logger.error(`Could not enqueue ${jobName}: ${describe(error)}`);
      return null;
    }
  }

  /**
   * Removes a scheduled job.
   *
   * Used when a reminder is rescheduled, completed or deleted. A job that
   * has already started cannot be removed, which is why the handler
   * re-reads the reminder before acting rather than trusting its payload.
   */
  async cancel(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.queue(queueName);
    if (!queue) return false;

    try {
      // `getJob` resolves to `any` under bullmq's own types, so the shape
      // this code relies on is stated explicitly rather than inferred.
      const job = (await queue.getJob(jobId)) as { remove: () => Promise<unknown> } | undefined;
      if (!job) return false;
      await job.remove();
      return true;
    } catch (error) {
      this.logger.warn(`Could not remove job ${jobId}: ${describe(error)}`);
      return false;
    }
  }

  async findJob(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.queue(queueName);
    if (!queue) return false;
    try {
      return (await queue.getJob(jobId)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Installs the recurring maintenance schedule.
   *
   * Each entry has a stable key, so a restart replaces its schedule rather
   * than adding a second one. Without that, every deploy would multiply the
   * number of cleanup runs.
   */
  async installMaintenanceSchedule(): Promise<number> {
    const queue = this.queue(QUEUE.maintenance);
    if (!queue) return 0;

    let installed = 0;
    for (const entry of MAINTENANCE_SCHEDULE) {
      try {
        await queue.add(
          entry.name,
          {},
          {
            ...RETRY,
            repeat: { every: entry.everyMs },
            jobId: `repeat:${entry.key}`,
          },
        );
        installed += 1;
      } catch (error) {
        this.logger.warn(`Could not schedule ${entry.name}: ${describe(error)}`);
      }
    }
    return installed;
  }

  /** Queue depths, for the readiness probe and for monitoring. */
  async counts(): Promise<Record<string, Record<string, number>> | null> {
    if (!this.available) return null;

    const result: Record<string, Record<string, number>> = {};
    for (const name of Object.values(QUEUE)) {
      const queue = this.queue(name);
      if (!queue) continue;
      try {
        result[name] = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      } catch (error) {
        this.logger.warn(`Could not read counts for ${name}: ${describe(error)}`);
      }
    }
    return result;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
