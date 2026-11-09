import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { JobsService } from '../src/jobs/jobs.service';
import { JOB, QUEUE } from '../src/jobs/queue.constants';
import { QueueService } from '../src/jobs/queue.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { RemindersService, jobIdFor } from '../src/modules/reminders/reminders.service';
import { PushRegistry } from '../src/providers/push/push.module';
import { PushError } from '../src/providers/push/errors';
import type { MockPushProvider } from '../src/providers/push/mock.provider';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type Envelope,
  type ErrorBody,
} from './helpers/app';

interface ReminderView {
  id: string;
  text: string;
  dueAt: string;
  local: { display: string; zone: string; offsetMinutes: number };
  timezone: string;
  rrule: string | null;
  recurring: boolean;
  status: string;
  scheduled: boolean;
  firedAt: string | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  snoozeCount: number;
  version: number;
  adjusted: { reason: string; detail: string } | null;
}

describe('reminders, scheduling and notifications', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;
  let queue: QueueService;
  let jobs: JobsService;
  let reminders: RemindersService;
  let notifications: NotificationsService;
  let push: MockPushProvider;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
    queue = app.get(QueueService);
    jobs = app.get(JobsService);
    reminders = app.get(RemindersService);
    notifications = app.get(NotificationsService);
    push = app.get(PushRegistry).byId('mock') as MockPushProvider;

    // Durable scheduling really is available in this suite; the tests below
    // would be meaningless against an unavailable queue.
    expect(queue.available).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    push.reset();
  });

  async function newAccount(timezone = 'Asia/Kolkata') {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('rem'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    await prisma.user.update({ where: { id: body.data.user.id }, data: { timezone } });
    return {
      email: body.data.user.email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
    };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Polls until a condition yields a value, for the live workers. */
  async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 8_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for the workers');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function create(token: string, body: Record<string, unknown>) {
    const res = await request(http())
      .post('/api/v1/reminders')
      .set(auth(token))
      .send(body)
      .expect(201);
    return (res.body as Envelope<ReminderView>).data;
  }

  /**
   * A time safely in the future, as an absolute instant.
   *
   * A full ISO string with an offset, not a bare wall-clock reading: the
   * latter would be interpreted in the account's zone, and `16:38` read as
   * Kolkata time is five and a half hours earlier than `16:38` UTC — which
   * for a "two hours from now" fixture lands in the past.
   */
  function soon(minutesAhead = 120): string {
    return new Date(Date.now() + minutesAhead * 60_000).toISOString();
  }

  async function registerPushToken(token: string) {
    await request(http())
      .post('/api/v1/notifications/token')
      .set(auth(token))
      .send({ pushToken: `device-token-${Math.random().toString(36).slice(2)}` })
      .expect(200);
  }

  // ──────────────────────────────────────────────────────────────── CRUD

  describe('create, read, update, delete', () => {
    it('creates a reminder and actually schedules it', async () => {
      const account = await newAccount();
      const reminder = await create(account.access, { text: 'Gym', dueAt: soon() });

      expect(reminder.text).toBe('Gym');
      expect(reminder.timezone).toBe('Asia/Kolkata');
      expect(reminder.status).toBe('SCHEDULED');
      // Derived from the job id, not asserted: a reminder with no job will
      // not fire, and this is how the user finds out.
      expect(reminder.scheduled).toBe(true);

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
      expect(row.jobId).toBe(jobIdFor(row.id, row.dueAt));
      // And the job genuinely exists in Redis, not just in our row.
      expect(await queue.findJob(QUEUE.reminders, row.jobId!)).toBe(true);
    });

    it('presents the wall-clock reading alongside the instant', async () => {
      const account = await newAccount('Asia/Kolkata');
      const reminder = await create(account.access, {
        text: 'Morning',
        dueAt: '2030-01-05T08:00',
      });

      expect(reminder.dueAt).toBe('2030-01-05T02:30:00.000Z');
      expect(reminder.local.display).toBe('Sat, 05 Jan 2030, 08:00');
      expect(reminder.local.offsetMinutes).toBe(330);
    });

    it('uses the account’s zone when the client states none', async () => {
      const account = await newAccount('Europe/London');
      const reminder = await create(account.access, { text: 'Tea', dueAt: '2030-06-05T16:00' });

      expect(reminder.timezone).toBe('Europe/London');
      // 16:00 BST is 15:00 UTC — not assumed to be the server's zone.
      expect(reminder.dueAt).toBe('2030-06-05T15:00:00.000Z');
    });

    it('refuses an unknown zone rather than substituting one', async () => {
      const account = await newAccount();
      const res = await request(http())
        .post('/api/v1/reminders')
        .set(auth(account.access))
        .send({ text: 'x', dueAt: soon(), timezone: 'Mars/Olympus' })
        .expect(400);
      expect((res.body as ErrorBody).message).toContain('not a known time zone');
    });

    it('refuses a time in the past', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/reminders')
        .set(auth(account.access))
        .send({ text: 'x', dueAt: '2020-01-01T09:00' })
        .expect(400);
    });

    it('reports a daylight-saving adjustment rather than moving the time silently', async () => {
      const account = await newAccount('Europe/London');
      // 01:30 on the night the clocks go forward does not exist.
      const reminder = await create(account.access, {
        text: 'Impossible',
        dueAt: '2030-03-31T01:30',
      });

      expect(reminder.adjusted).not.toBeNull();
      expect(reminder.adjusted!.reason).toBe('skipped');
      expect(reminder.adjusted!.detail).toContain('does not exist');
    });

    it('updates and reschedules, cancelling the old job', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon(120) });
      const oldJobId = (await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } }))
        .jobId!;

      const res = await request(http())
        .patch(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .send({ dueAt: soon(240), expectedVersion: 1 })
        .expect(200);
      const updated = (res.body as Envelope<ReminderView>).data;

      expect(updated.version).toBe(2);
      expect(updated.scheduled).toBe(true);

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.jobId).not.toBe(oldJobId);
      // The superseded job is gone, so it cannot fire at the old time.
      expect(await queue.findJob(QUEUE.reminders, oldJobId)).toBe(false);
      expect(await queue.findJob(QUEUE.reminders, row.jobId!)).toBe(true);
    });

    it('refuses an edit built on a stale version', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });
      await request(http())
        .patch(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .send({ text: 'Gym, moved' })
        .expect(200);

      const res = await request(http())
        .patch(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .send({ text: 'mine', expectedVersion: 1 })
        .expect(409);
      expect((res.body as ErrorBody).message).toContain('Nothing was overwritten');
    });

    it('soft-deletes and cancels the job', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });
      const jobId = (await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } })).jobId!;

      await request(http())
        .delete(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .expect(200);

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.status).toBe('CANCELLED');
      expect(await queue.findJob(QUEUE.reminders, jobId)).toBe(false);
    });

    it('is idempotent with a client id', async () => {
      const account = await newAccount();
      const first = await create(account.access, {
        text: 'Gym',
        dueAt: soon(),
        clientId: 'local-1',
      });
      const second = await create(account.access, {
        text: 'Gym, edited',
        dueAt: soon(180),
        clientId: 'local-1',
      });

      expect(second.id).toBe(first.id);
      expect(await prisma.reminder.count({ where: { userId: account.userId } })).toBe(1);
    });
  });

  // ────────────────────────────────────────────── complete and snooze

  describe('completing and snoozing', () => {
    it('completes a one-off reminder and cancels its job', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });

      const res = await request(http())
        .post(`/api/v1/reminders/${created.id}/complete`)
        .set(auth(account.access))
        .expect(201);
      const done = (res.body as Envelope<ReminderView>).data;

      expect(done.status).toBe('DONE');
      expect(done.completedAt).not.toBeNull();
      expect(done.scheduled).toBe(false);
    });

    it('advances a recurring reminder instead of ending it', async () => {
      const account = await newAccount('Asia/Kolkata');
      const created = await create(account.access, {
        text: 'Standup',
        dueAt: '2030-01-07T09:00',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      });
      expect(created.recurring).toBe(true);

      const res = await request(http())
        .post(`/api/v1/reminders/${created.id}/complete`)
        .set(auth(account.access))
        .expect(201);
      const next = (res.body as Envelope<ReminderView>).data;

      // Completing one occurrence does not end the series.
      expect(next.status).toBe('SCHEDULED');
      expect(next.scheduled).toBe(true);
      expect(new Date(next.dueAt).getTime()).toBeGreaterThan(new Date(created.dueAt).getTime());
      // Still 09:00 on the wall.
      expect(next.local.display).toContain('09:00');
    });

    it('snoozes from now, not from the time that was missed', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon(1_000) });

      const before = Date.now();
      const res = await request(http())
        .post(`/api/v1/reminders/${created.id}/snooze`)
        .set(auth(account.access))
        .send({ minutes: 15 })
        .expect(201);
      const snoozed = (res.body as Envelope<ReminderView>).data;

      expect(snoozed.status).toBe('SNOOZED');
      expect(snoozed.snoozeCount).toBe(1);
      expect(snoozed.snoozedUntil).not.toBeNull();

      // Roughly fifteen minutes from now — not fifteen minutes after the
      // original due time, which is what pressing snooze does not mean.
      const until = new Date(snoozed.dueAt).getTime();
      expect(until).toBeGreaterThanOrEqual(before + 14 * 60_000);
      expect(until).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
      expect(snoozed.scheduled).toBe(true);
    });

    it('counts repeated snoozes', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });

      for (const expected of [1, 2, 3]) {
        const res = await request(http())
          .post(`/api/v1/reminders/${created.id}/snooze`)
          .set(auth(account.access))
          .send({ minutes: 5 })
          .expect(201);
        expect((res.body as Envelope<ReminderView>).data.snoozeCount).toBe(expected);
      }
    });

    it('refuses to snooze something already done', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });
      await request(http())
        .post(`/api/v1/reminders/${created.id}/complete`)
        .set(auth(account.access))
        .expect(201);

      await request(http())
        .post(`/api/v1/reminders/${created.id}/snooze`)
        .set(auth(account.access))
        .send({ minutes: 5 })
        .expect(409);
    });
  });

  // ────────────────────────────────────────────────── recurring rules

  describe('recurring rules', () => {
    it('refuses a rule that repeats too often', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/reminders')
        .set(auth(account.access))
        .send({ text: 'x', dueAt: soon(), rrule: 'FREQ=MINUTELY' })
        .expect(400);
    });

    it('refuses an unreadable rule', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/reminders')
        .set(auth(account.access))
        .send({ text: 'x', dueAt: soon(), rrule: 'NONSENSE' })
        .expect(400);
    });

    it('stores nothing when the rule is refused', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/reminders')
        .set(auth(account.access))
        .send({ text: 'x', dueAt: soon(), rrule: 'FREQ=SECONDLY' })
        .expect(400);
      // Parsed before anything is written, so there is no stored reminder
      // that would never fire.
      expect(await prisma.reminder.count({ where: { userId: account.userId } })).toBe(0);
    });

    it('can stop a reminder recurring', async () => {
      const account = await newAccount();
      const created = await create(account.access, {
        text: 'Standup',
        dueAt: soon(),
        rrule: 'FREQ=DAILY',
      });

      const res = await request(http())
        .patch(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .send({ rrule: '' })
        .expect(200);
      expect((res.body as Envelope<ReminderView>).data.recurring).toBe(false);
    });
  });

  // ─────────────────────────────────────────────── listing and history

  describe('listing, upcoming and history', () => {
    it('lists upcoming reminders in order', async () => {
      const account = await newAccount();
      await create(account.access, { text: 'later', dueAt: soon(600) });
      await create(account.access, { text: 'sooner', dueAt: soon(60) });

      const res = await request(http())
        .get('/api/v1/reminders/upcoming')
        .set(auth(account.access))
        .expect(200);
      const list = (res.body as Envelope<ReminderView[]>).data;

      expect(list.map((r) => r.text)).toEqual(['sooner', 'later']);
    });

    it('excludes a completed reminder from upcoming', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });
      await request(http())
        .post(`/api/v1/reminders/${created.id}/complete`)
        .set(auth(account.access))
        .expect(201);

      const res = await request(http())
        .get('/api/v1/reminders/upcoming')
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<ReminderView[]>).data).toHaveLength(0);
    });

    it('filters and searches', async () => {
      const account = await newAccount();
      await create(account.access, { text: 'call the dentist', dueAt: soon(60) });
      await create(account.access, { text: 'buy milk', dueAt: soon(120) });

      const res = await request(http())
        .get('/api/v1/reminders?q=DENTIST')
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<{ meta: { total: number } }>).data.meta.total).toBe(1);
    });
  });

  // ────────────────────────────────────────────────── durable delivery

  describe('delivery', () => {
    /** Runs the delivery job for a reminder the way the worker would. */
    async function fire(reminderId: string) {
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: reminderId } });
      return (
        jobs as unknown as {
          handle: (job: { name: string; data: unknown }) => Promise<unknown>;
        }
      ).handle({
        name: JOB.deliverReminder,
        data: { reminderId, scheduledFor: row.dueAt.toISOString() },
      });
    }

    it('creates an occurrence and a notification when it fires', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });

      await fire(created.id);

      const occurrence = await prisma.reminderOccurrence.findFirstOrThrow({
        where: { reminderId: created.id },
      });
      expect(occurrence.firedAt).not.toBeNull();
      expect(occurrence.notificationId).not.toBeNull();

      const notification = await prisma.notification.findUniqueOrThrow({
        where: { id: occurrence.notificationId! },
      });
      expect(notification.type).toBe('reminder.due');
      expect(notification.title).toBe('Gym');

      // Dispatch runs on its own queue and the workers are live in this
      // suite, so the status settles a moment later. What matters is that
      // it settles into something honest: accepted by a transport, or
      // recorded as undeliverable — never "delivered".
      const settled = await waitFor(async () => {
        const row = await prisma.notification.findUniqueOrThrow({
          where: { id: notification.id },
        });
        return row.status === 'QUEUED' || row.status === 'SENDING' ? null : row;
      });
      expect(['SENT', 'UNDELIVERABLE', 'FAILED']).toContain(settled.status);
      // A transport accepting is not a person seeing: nothing marks it read.
      expect(settled.readAt).toBeNull();

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.status).toBe('FIRED');
      expect(row.firedAt).not.toBeNull();
    });

    it('fires one occurrence however many times the job runs', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });

      // At-least-once delivery: a worker that died after doing the work
      // gets handed the same job again.
      await fire(created.id);
      await fire(created.id);
      await fire(created.id);

      // The unique constraint on (reminderId, scheduledFor) is what makes
      // the second and third runs no-ops.
      expect(await prisma.reminderOccurrence.count({ where: { reminderId: created.id } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: account.userId } })).toBe(1);
    });

    it('skips a reminder that was deleted or completed in the meantime', async () => {
      const account = await newAccount();
      const deleted = await create(account.access, { text: 'gone', dueAt: soon() });
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: deleted.id } });
      await request(http())
        .delete(`/api/v1/reminders/${deleted.id}`)
        .set(auth(account.access))
        .expect(200);

      // The payload cannot know the reminder has gone, so the handler
      // re-reads it rather than trusting it.
      await (
        jobs as unknown as { handle: (job: { name: string; data: unknown }) => Promise<unknown> }
      ).handle({
        name: JOB.deliverReminder,
        data: { reminderId: deleted.id, scheduledFor: row.dueAt.toISOString() },
      });

      expect(await prisma.reminderOccurrence.count({ where: { reminderId: deleted.id } })).toBe(0);
    });

    it('skips a job whose reminder has since been rescheduled', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon(120) });
      const originalDue = (await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } }))
        .dueAt;

      await request(http())
        .patch(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .send({ dueAt: soon(300) })
        .expect(200);

      // A job for the old time must not fire.
      await (
        jobs as unknown as { handle: (job: { name: string; data: unknown }) => Promise<unknown> }
      ).handle({
        name: JOB.deliverReminder,
        data: { reminderId: created.id, scheduledFor: originalDue.toISOString() },
      });

      expect(await prisma.reminderOccurrence.count({ where: { reminderId: created.id } })).toBe(0);
    });

    it('advances a recurring reminder after firing, keeping the wall-clock hour', async () => {
      const account = await newAccount('Europe/London');
      // A Monday 09:00 in British Summer Time; the next occurrence falls
      // after the clocks go back.
      const created = await create(account.access, {
        text: 'Standup',
        dueAt: '2030-10-21T09:00',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      });
      // Brought forward so the job is due, without changing the rule.
      await prisma.reminder.update({
        where: { id: created.id },
        data: { dueAt: new Date('2030-10-21T08:00:00.000Z') },
      });

      await fire(created.id);

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.status).toBe('SCHEDULED');
      expect(row.jobId).not.toBeNull();

      const view = await reminders.get(account.userId, created.id);
      // Still 09:00 on the wall, which means a different instant now that
      // the offset has changed.
      expect(view.local.display).toContain('09:00');
      expect(view.local.offsetMinutes).toBe(0);
    });

    it('records the history of what fired', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);
      const created = await create(account.access, { text: 'Gym', dueAt: soon() });
      await fire(created.id);

      const res = await request(http())
        .get('/api/v1/reminders/history')
        .set(auth(account.access))
        .expect(200);
      const page = (res.body as Envelope<{ items: { text: string; status: string; notificationId: string | null }[] }>)
        .data;

      expect(page.items).toHaveLength(1);
      expect(page.items[0].text).toBe('Gym');
      expect(page.items[0].notificationId).not.toBeNull();
    });
  });

  // ──────────────────────────────────────────────── reconciliation

  describe('reconciliation', () => {
    it('re-schedules a reminder whose job was lost', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'Gym', dueAt: soon(10) });
      const jobId = (await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } })).jobId!;

      // Redis loses the job — a flush, a restart with no persistence, or a
      // crash between writing the row and enqueueing.
      await queue.cancel(QUEUE.reminders, jobId);
      expect(await queue.findJob(QUEUE.reminders, jobId)).toBe(false);

      // Without this sweep the reminder would simply never fire. It is the
      // bridge between two systems that cannot be written to atomically.
      expect(await reminders.reconcile()).toBeGreaterThanOrEqual(1);
      expect(await queue.findJob(QUEUE.reminders, jobId)).toBe(true);
    });

    it('leaves an intact schedule alone', async () => {
      const account = await newAccount();
      await create(account.access, { text: 'Gym', dueAt: soon(10) });

      const repaired = await reminders.reconcile();
      // Nothing to repair for this account; the sweep is idempotent.
      expect(repaired).toBe(0);
    });

    it('does not resurrect a deleted reminder', async () => {
      const account = await newAccount();
      const created = await create(account.access, { text: 'gone', dueAt: soon(10) });
      await request(http())
        .delete(`/api/v1/reminders/${created.id}`)
        .set(auth(account.access))
        .expect(200);

      await reminders.reconcile();
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.jobId).toBeNull();
    });
  });

  // ────────────────────────────────────────────────── notifications

  describe('notification delivery', () => {
    it('hands a notification to a transport and does not claim it was seen', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);

      const queued = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
      });
      const report = await notifications.dispatch(queued.id);

      expect(report.accepted).toBe(true);
      expect(report.status).toBe('SENT');
      // The wording is the point: a transport took it. Nobody has seen it.
      expect(report.detail).toBe('Accepted by a transport. Not confirmed as seen.');
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0].message.title).toBe('Gym');

      const row = await prisma.notification.findUniqueOrThrow({ where: { id: queued.id } });
      expect(row.sentAt).not.toBeNull();
      expect(row.readAt).toBeNull();
      expect(row.attemptCount).toBe(1);
    });

    it('records undeliverable rather than failed when no device has a token', async () => {
      const account = await newAccount();
      // No push token registered.
      const queued = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
      });
      const report = await notifications.dispatch(queued.id);

      // Nothing was attempted and nothing will be — which is a different
      // and more useful thing to record than a delivery failure.
      expect(report.accepted).toBe(false);
      expect(report.status).toBe('UNDELIVERABLE');
      expect(report.failureCode).toBe('no_transport');
      expect(push.sent).toHaveLength(0);

      // It is still in the in-app list, so a user who opens the app sees it.
      const res = await request(http())
        .get('/api/v1/notifications')
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<{ items: unknown[] }>).data.items).toHaveLength(1);
    });

    it('deduplicates by key, so one occurrence makes one notification', async () => {
      const account = await newAccount();
      const input = {
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
        dedupeKey: `reminder:${account.userId}:123`,
      };

      const first = await notifications.queue(input);
      const second = await notifications.queue(input);

      expect(second.id).toBe(first.id);
      expect(second.duplicate).toBe(true);
      expect(await prisma.notification.count({ where: { userId: account.userId } })).toBe(1);
    });

    it('is idempotent about dispatch', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);
      const queued = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
      });

      await notifications.dispatch(queued.id);
      const again = await notifications.dispatch(queued.id);

      // An already-sent notification is left alone, because this runs from
      // a job that may be retried.
      expect(again.status).toBe('SENT');
      expect(push.sent).toHaveLength(1);
    });

    it('re-throws a retryable failure so the queue backs off', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);
      push.failWith(new PushError('unavailable', 'mock', 'transport down'));

      const queued = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
      });

      await expect(notifications.dispatch(queued.id)).rejects.toBeInstanceOf(PushError);

      const row = await prisma.notification.findUniqueOrThrow({ where: { id: queued.id } });
      expect(row.status).toBe('FAILED');
      expect(row.attemptCount).toBe(1);
    });

    it('records a permanent failure without retrying it', async () => {
      const account = await newAccount();
      await registerPushToken(account.access);
      push.failWith(new PushError('invalid_request', 'mock', 'bad token', { status: 400 }));

      const queued = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
      });
      const report = await notifications.dispatch(queued.id);

      expect(report.accepted).toBe(false);
      expect(report.status).toBe('FAILED');

      // A rejected token is cleared, so nothing keeps trying it.
      const device = await prisma.device.findUniqueOrThrow({ where: { id: account.deviceId } });
      expect(device.pushToken).toBeNull();
    });

    it('creates nothing when the user has that notification type muted', async () => {
      const account = await newAccount();
      await prisma.userPreference.upsert({
        where: { userId: account.userId },
        create: { userId: account.userId, assistant: { mutedTypes: ['reminder.due'] } },
        update: { assistant: { mutedTypes: ['reminder.due'] } },
      });

      const queued = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'Gym',
      });

      // Not created at all, rather than created and then not sent: there is
      // nothing to report on, and a row would imply we tried.
      expect(queued.id).toBe('');
      expect(await prisma.notification.count({ where: { userId: account.userId } })).toBe(0);
    });

    it('marks notifications read, and counts the unread', async () => {
      const account = await newAccount();
      const first = await notifications.queue({
        userId: account.userId,
        type: 'reminder.due',
        title: 'One',
      });
      await notifications.queue({ userId: account.userId, type: 'reminder.due', title: 'Two' });

      const before = await request(http())
        .get('/api/v1/notifications/unread-count')
        .set(auth(account.access))
        .expect(200);
      expect((before.body as Envelope<{ unread: number }>).data.unread).toBe(2);

      await request(http())
        .post(`/api/v1/notifications/${first.id}/read`)
        .set(auth(account.access))
        .expect(200);

      const after = await request(http())
        .get('/api/v1/notifications/unread-count')
        .set(auth(account.access))
        .expect(200);
      expect((after.body as Envelope<{ unread: number }>).data.unread).toBe(1);

      await request(http())
        .post('/api/v1/notifications/read-all')
        .set(auth(account.access))
        .expect(200);
      const cleared = await request(http())
        .get('/api/v1/notifications/unread-count')
        .set(auth(account.access))
        .expect(200);
      expect((cleared.body as Envelope<{ unread: number }>).data.unread).toBe(0);
    });

    it('reports which transports exist, per device', async () => {
      const account = await newAccount();
      const res = await request(http())
        .get('/api/v1/notifications/transports')
        .set(auth(account.access))
        .expect(200);
      const body = (res.body as Envelope<{
        hasRealTransport: boolean;
        devices: { registered: boolean; reachable: boolean; provider: { isMock: boolean } | null }[];
      }>).data;

      // No real credential in this repository, so nothing is pretended.
      expect(body.hasRealTransport).toBe(false);
      expect(body.devices[0].registered).toBe(false);
      expect(body.devices[0].reachable).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────── isolation

  describe('isolation', () => {
    it('hides another account’s reminder entirely', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const reminder = await create(owner.access, { text: 'private', dueAt: soon() });

      for (const call of [
        () => request(http()).get(`/api/v1/reminders/${reminder.id}`).set(auth(stranger.access)),
        () =>
          request(http())
            .post(`/api/v1/reminders/${reminder.id}/complete`)
            .set(auth(stranger.access)),
        () => request(http()).delete(`/api/v1/reminders/${reminder.id}`).set(auth(stranger.access)),
      ]) {
        await call().expect(404);
      }

      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
      expect(row.status).toBe('SCHEDULED');
      expect(row.deletedAt).toBeNull();
    });

    it('never shows another account’s notifications', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const queued = await notifications.queue({
        userId: owner.userId,
        type: 'reminder.due',
        title: 'private',
      });

      const res = await request(http())
        .get('/api/v1/notifications')
        .set(auth(stranger.access))
        .expect(200);
      expect((res.body as Envelope<{ items: unknown[] }>).data.items).toHaveLength(0);

      await request(http())
        .post(`/api/v1/notifications/${queued.id}/read`)
        .set(auth(stranger.access))
        .expect(404);
    });

    it('requires authentication', async () => {
      const id = '4f1e2d3c-0000-4000-8000-000000000000';
      await request(http()).get('/api/v1/reminders').expect(401);
      await request(http()).post('/api/v1/reminders').send({ text: 'x', dueAt: 'x' }).expect(401);
      await request(http()).get('/api/v1/reminders/upcoming').expect(401);
      await request(http()).get('/api/v1/notifications').expect(401);
      await request(http()).post(`/api/v1/notifications/${id}/read`).expect(401);
    });
  });

  // ────────────────────────────────────────────── jobs and monitoring

  describe('background jobs', () => {
    it('reports queue depths and worker state', async () => {
      const report = await jobs.inspect();
      expect(report.available).toBe(true);
      expect(report.workers).toBeGreaterThan(0);
      expect(report.running).toBeGreaterThan(0);
      expect(report.counts).not.toBeNull();
      expect(Object.keys(report.counts!)).toContain(QUEUE.reminders);
    });

    it('runs each maintenance handler idempotently', async () => {
      for (const name of [
        JOB.reconcileReminders,
        JOB.reconcileActions,
        JOB.expireStale,
        JOB.cleanupAudio,
        JOB.cleanupSessions,
        JOB.purgeDeleted,
      ]) {
        // Twice, because a queue gives at-least-once delivery.
        const first = await jobs.runNow(name);
        const second = await jobs.runNow(name);
        expect(first.handled).toBe(name);
        expect(second.handled).toBe(name);
      }
    }, 60_000);

    it('refuses a job it has no handler for', async () => {
      await expect(jobs.runNow('maintenance.nonexistent')).rejects.toThrow(/No handler/);
    });

    it('expires overdue voice sessions and pending actions', async () => {
      const report = await jobs.runNow(JOB.expireStale);
      expect(report.detail).toHaveProperty('voiceSessions');
      expect(report.detail).toHaveProperty('pendingActions');
    });
  });
});
