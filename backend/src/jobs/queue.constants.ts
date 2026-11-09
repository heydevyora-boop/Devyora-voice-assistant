/**
 * Queue and job names.
 *
 * In one place because a job name is a contract between a producer and a
 * consumer that outlives a deploy: a job enqueued by the old build is
 * picked up by the new one. A typo in a string literal on either side is a
 * job that silently never runs.
 */

/**
 * Queue names.
 *
 * Hyphens, not colons: BullMQ uses `:` as its own Redis key separator and
 * refuses a queue name containing one.
 */
export const QUEUE = {
  /** Reminder delivery. One job per occurrence. */
  reminders: 'devyora-reminders',
  /** Notification dispatch, separate so a slow transport cannot delay a firing. */
  notifications: 'devyora-notifications',
  /** Retention, reconciliation and cleanup. Scheduled, not user-triggered. */
  maintenance: 'devyora-maintenance',
} as const;

export const JOB = {
  /** Fire one occurrence of a reminder. */
  deliverReminder: 'reminder.deliver',
  /** Send one notification through a transport. */
  sendNotification: 'notification.send',

  /** Find reminders whose scheduled job is missing and re-enqueue them. */
  reconcileReminders: 'maintenance.reconcile-reminders',
  /** Expire overdue voice sessions and pending actions. */
  expireStale: 'maintenance.expire-stale',
  /** Delete temporary audio past its retention. */
  cleanupAudio: 'maintenance.cleanup-audio',
  /** Close sessions whose refresh tokens have all expired. */
  cleanupSessions: 'maintenance.cleanup-sessions',
  /** Purge soft-deleted records past the retention window. */
  purgeDeleted: 'maintenance.purge-deleted',
  /** Mark abandoned action attempts as unverified. */
  reconcileActions: 'maintenance.reconcile-actions',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * Retry policy.
 *
 * Three attempts with exponential backoff. Deliberately modest: a reminder
 * that cannot be delivered after three tries over a couple of minutes is
 * not going to succeed on the fourth, and a reminder delivered an hour late
 * is worse than one reported as failed. The occurrence row records which
 * happened either way.
 */
export const RETRY = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  /** Keep a bounded history, so a failing job is diagnosable. */
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400, count: 1_000 },
} as const;

/**
 * The maintenance schedule.
 *
 * Expressed as repeat intervals rather than cron strings: these are "every
 * so often" tasks with no business being tied to a wall-clock time, and an
 * interval has no timezone to get wrong.
 */
export const MAINTENANCE_SCHEDULE: readonly {
  name: JobName;
  everyMs: number;
  /** A stable id, so a restart replaces the schedule rather than adding one. */
  key: string;
}[] = [
  { name: JOB.reconcileReminders, everyMs: 60_000, key: 'reconcile-reminders' },
  { name: JOB.expireStale, everyMs: 300_000, key: 'expire-stale' },
  { name: JOB.reconcileActions, everyMs: 120_000, key: 'reconcile-actions' },
  { name: JOB.cleanupAudio, everyMs: 600_000, key: 'cleanup-audio' },
  { name: JOB.cleanupSessions, everyMs: 3_600_000, key: 'cleanup-sessions' },
  { name: JOB.purgeDeleted, everyMs: 21_600_000, key: 'purge-deleted' },
];
