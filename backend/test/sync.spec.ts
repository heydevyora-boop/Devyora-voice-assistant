import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type Envelope,
  type ErrorBody,
} from './helpers/app';

interface RecordResult {
  clientId: string;
  id: string | null;
  outcome: 'created' | 'updated' | 'unchanged' | 'conflict' | 'deleted' | 'rejected';
  version: number | null;
  server: { version: number; content?: string; text?: string } | null;
  detail: string | null;
}

interface PushResponse {
  notes: RecordResult[];
  reminders: RecordResult[];
  summary: { received: number; applied: number; conflicts: number; rejected: number };
  note: string;
}

interface PullResponse {
  notes: { id: string; clientId: string | null; content: string; version: number; deleted: boolean }[];
  reminders: { id: string; clientId: string | null; text: string; version: number; deleted: boolean }[];
  cursor: { notes: string | null; reminders: string | null };
  hasMore: boolean;
  serverTime: string;
}

describe('offline-first synchronisation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  async function newAccount() {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('sync'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return {
      email: body.data.user.email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
    };
  }

  async function secondDevice(email: string) {
    const res = await request(http())
      .post('/api/v1/auth/login')
      .send({
        email,
        password: STRONG_PASSWORD,
        device: { platform: 'MACOS', name: 'Laptop', deviceType: 'laptop' },
      })
      .expect(200);
    const body = res.body as AuthBody;
    return { deviceId: body.data.device.id, access: body.data.tokens.accessToken! };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function push(token: string, body: Record<string, unknown>) {
    const res = await request(http())
      .post('/api/v1/sync/push')
      .set(auth(token))
      .send(body)
      .expect(200);
    return (res.body as Envelope<PushResponse>).data;
  }

  async function pull(token: string, query = '') {
    const res = await request(http())
      .get(`/api/v1/sync/pull${query}`)
      .set(auth(token))
      .expect(200);
    return (res.body as Envelope<PullResponse>).data;
  }

  // ───────────────────────────────────────────────────────────────── push

  describe('upload', () => {
    it('creates records a device made while offline', async () => {
      const account = await newAccount();

      const result = await push(account.access, {
        notes: [
          { clientId: 'n1', content: 'first offline note' },
          { clientId: 'n2', content: 'second offline note', pinned: true },
        ],
        reminders: [{ clientId: 'r1', text: 'gym', dueAt: '2030-01-05T09:00', timezone: 'Asia/Kolkata' }],
      });

      expect(result.summary).toMatchObject({ received: 3, applied: 3, conflicts: 0, rejected: 0 });
      expect(result.notes.every((n) => n.outcome === 'created')).toBe(true);
      expect(result.reminders[0].outcome).toBe('created');

      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(2);
      expect(await prisma.reminder.count({ where: { userId: account.userId } })).toBe(1);
    });

    it('is idempotent: a replayed batch changes nothing', async () => {
      const account = await newAccount();
      const batch = { notes: [{ clientId: 'n1', content: 'the same note' }] };

      const first = await push(account.access, batch);
      expect(first.notes[0].outcome).toBe('created');

      // The dropped-connection case: the client never saw the response.
      const second = await push(account.access, batch);
      expect(second.notes[0].outcome).toBe('unchanged');
      expect(second.notes[0].id).toBe(first.notes[0].id);

      // One row, and its version did not move — otherwise every other
      // device would re-download it for nothing.
      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(1);
      expect(second.notes[0].version).toBe(1);
    });

    it('applies a genuine change and bumps the version', async () => {
      const account = await newAccount();
      await push(account.access, { notes: [{ clientId: 'n1', content: 'original' }] });

      const result = await push(account.access, {
        notes: [{ clientId: 'n1', content: 'edited', baseVersion: 1 }],
      });
      expect(result.notes[0].outcome).toBe('updated');
      expect(result.notes[0].version).toBe(2);
    });

    it('rejects a batch over the size limit', async () => {
      const account = await newAccount();
      const notes = Array.from({ length: 201 }, (_, i) => ({
        clientId: `bulk-${i}`,
        content: `note ${i}`,
      }));

      const res = await request(http())
        .post('/api/v1/sync/push')
        .set(auth(account.access))
        .send({ notes })
        .expect(400);
      expect((res.body as ErrorBody).message).toContain('at most');
    });

    it('rejects one bad record without failing the batch', async () => {
      const account = await newAccount();

      const result = await push(account.access, {
        notes: [{ clientId: 'good', content: 'fine' }],
        reminders: [
          { clientId: 'bad-zone', text: 'x', dueAt: '2030-01-05T09:00', timezone: 'Mars/Olympus' },
          { clientId: 'bad-time', text: 'x', dueAt: 'not-a-date' },
          { clientId: 'incomplete' },
        ],
      });

      // A device with fifty queued changes and one bad record should get
      // forty-nine applied and be told about the one.
      expect(result.notes[0].outcome).toBe('created');
      expect(result.reminders[0].outcome).toBe('rejected');
      expect(result.reminders[0].detail).toContain('not a known time zone');
      expect(result.reminders[2].outcome).toBe('rejected');
      expect(result.summary.rejected).toBeGreaterThanOrEqual(2);
      expect(result.summary.applied).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────── conflicts

  describe('conflict resolution', () => {
    it('refuses a push built on a stale version and returns the server copy', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);

      await push(account.access, { notes: [{ clientId: 'n1', content: 'original' }] });

      // The other device edits it first.
      await push(other.access, { notes: [{ clientId: 'n1', content: 'from the laptop', baseVersion: 1 }] });

      // This device was offline and still thinks it is on version 1.
      const result = await push(account.access, {
        notes: [{ clientId: 'n1', content: 'from the phone', baseVersion: 1 }],
      });

      expect(result.notes[0].outcome).toBe('conflict');
      expect(result.notes[0].version).toBe(2);
      // The server's copy comes back with the conflict, so the client can
      // resolve it without another round trip.
      expect(result.notes[0].server?.content).toBe('from the laptop');
      expect(result.notes[0].detail).toContain('based on 1');
      expect(result.note).toContain('was not applied');

      // Nothing was overwritten. This is the guarantee.
      const row = await prisma.note.findFirstOrThrow({
        where: { userId: account.userId, clientId: 'n1' },
      });
      expect(row.content).toBe('from the laptop');
      expect(row.version).toBe(2);
    });

    it('is not last-write-wins', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);
      await push(account.access, { notes: [{ clientId: 'n1', content: 'original' }] });
      await push(other.access, { notes: [{ clientId: 'n1', content: 'theirs', baseVersion: 1 }] });

      // A later push with an older base loses, however late it arrives. A
      // wall clock would have let the device that is three minutes fast win.
      const late = await push(account.access, {
        notes: [{ clientId: 'n1', content: 'mine, later', baseVersion: 1 }],
      });
      expect(late.notes[0].outcome).toBe('conflict');
    });

    it('lets a client overwrite deliberately by omitting the base version', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);
      await push(account.access, { notes: [{ clientId: 'n1', content: 'original' }] });
      await push(other.access, { notes: [{ clientId: 'n1', content: 'theirs', baseVersion: 1 }] });

      // The only way to win a conflict, which makes overwriting somebody's
      // work an explicit act rather than the side effect of a race.
      const forced = await push(account.access, {
        notes: [{ clientId: 'n1', content: 'mine, deliberately' }],
      });
      expect(forced.notes[0].outcome).toBe('updated');

      const row = await prisma.note.findFirstOrThrow({
        where: { userId: account.userId, clientId: 'n1' },
      });
      expect(row.content).toBe('mine, deliberately');
    });

    it('detects a conflict on a reminder too', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);

      await push(account.access, {
        reminders: [{ clientId: 'r1', text: 'gym', dueAt: '2030-01-05T09:00' }],
      });
      await push(other.access, {
        reminders: [{ clientId: 'r1', text: 'gym, moved', dueAt: '2030-01-05T10:00', baseVersion: 1 }],
      });

      const result = await push(account.access, {
        reminders: [{ clientId: 'r1', text: 'gym, mine', dueAt: '2030-01-05T11:00', baseVersion: 1 }],
      });
      expect(result.reminders[0].outcome).toBe('conflict');
      expect(result.reminders[0].server?.text).toBe('gym, moved');
    });
  });

  // ───────────────────────────────────────────────────────────── deletions

  describe('deleted records', () => {
    it('sends a deletion as a tombstone rather than an absence', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);

      await push(account.access, { notes: [{ clientId: 'n1', content: 'to be deleted' }] });
      // The other device catches up before the deletion.
      await pull(other.access);

      await push(account.access, { notes: [{ clientId: 'n1', deleted: true, baseVersion: 1 }] });

      const update = await pull(other.access);
      const tombstone = update.notes.find((n) => n.clientId === 'n1');

      // A device that was offline has to learn the note went. It cannot do
      // that if the row is simply absent.
      expect(tombstone).toBeDefined();
      expect(tombstone!.deleted).toBe(true);
      expect(tombstone!.version).toBe(2);
    });

    it('accepts a deletion of something the server never had', async () => {
      const account = await newAccount();
      const result = await push(account.access, {
        notes: [{ clientId: 'never-existed', deleted: true }],
      });
      // The client and the server agree it is gone. Not an error.
      expect(result.notes[0].outcome).toBe('unchanged');
      expect(result.notes[0].detail).toBe('Already absent.');
    });

    it('is idempotent about deleting twice', async () => {
      const account = await newAccount();
      await push(account.access, { notes: [{ clientId: 'n1', content: 'x' }] });
      await push(account.access, { notes: [{ clientId: 'n1', deleted: true }] });

      const again = await push(account.access, { notes: [{ clientId: 'n1', deleted: true }] });
      expect(again.notes[0].outcome).toBe('unchanged');
      expect(again.notes[0].detail).toBe('Already deleted.');
    });

    it('brings a record back when the client recreates it', async () => {
      const account = await newAccount();
      await push(account.access, { notes: [{ clientId: 'n1', content: 'x' }] });
      await push(account.access, { notes: [{ clientId: 'n1', deleted: true }] });

      const revived = await push(account.access, { notes: [{ clientId: 'n1', content: 'back' }] });
      expect(revived.notes[0].outcome).toBe('updated');

      const row = await prisma.note.findFirstOrThrow({
        where: { userId: account.userId, clientId: 'n1' },
      });
      expect(row.deletedAt).toBeNull();
      expect(row.content).toBe('back');
    });
  });

  // ──────────────────────────────────────────────────────── incremental

  describe('incremental pull', () => {
    it('returns everything on a first pull, then only what changed', async () => {
      const account = await newAccount();
      await push(account.access, {
        notes: [
          { clientId: 'n1', content: 'one' },
          { clientId: 'n2', content: 'two' },
        ],
      });

      const first = await pull(account.access);
      expect(first.notes).toHaveLength(2);
      expect(first.cursor.notes).not.toBeNull();

      // Nothing has changed since.
      const second = await pull(account.access, `?since=${encodeURIComponent(first.cursor.notes!)}`);
      // The boundary is inclusive, so the record changed at exactly the
      // cursor comes back again. A duplicate is harmless; a skipped record
      // is lost data.
      expect(second.notes.length).toBeLessThanOrEqual(1);

      await push(account.access, { notes: [{ clientId: 'n3', content: 'three' }] });
      const third = await pull(account.access, `?since=${encodeURIComponent(first.cursor.notes!)}`);
      expect(third.notes.map((n) => n.clientId)).toContain('n3');
    });

    it('remembers each device’s cursor separately', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);

      await push(account.access, { notes: [{ clientId: 'n1', content: 'one' }] });
      await pull(account.access);

      // The second device has never synced, so it gets everything.
      const theirs = await pull(other.access);
      expect(theirs.notes).toHaveLength(1);

      const status = await request(http())
        .get('/api/v1/sync/status')
        .set(auth(other.access))
        .expect(200);
      const body = (status.body as Envelope<{ cursor: { notes: string | null } }>).data;
      expect(body.cursor.notes).not.toBeNull();
    });

    it('paginates and says there is more', async () => {
      const account = await newAccount();
      const notes = Array.from({ length: 12 }, (_, i) => ({
        clientId: `p-${i}`,
        content: `note ${i}`,
      }));
      await push(account.access, { notes });

      const page = await pull(account.access, '?limit=5');
      expect(page.notes).toHaveLength(5);
      expect(page.hasMore).toBe(true);
    });

    it('reports the server clock, so a client can see its own drift', async () => {
      const account = await newAccount();
      const page = await pull(account.access);
      expect(Number.isFinite(Date.parse(page.serverTime))).toBe(true);
    });

    it('forgets the cursor on request, without touching data', async () => {
      const account = await newAccount();
      await push(account.access, { notes: [{ clientId: 'n1', content: 'one' }] });
      await pull(account.access);

      await request(http()).post('/api/v1/sync/reset').set(auth(account.access)).expect(200);

      // A full pull again, and the note is still there.
      const after = await pull(account.access);
      expect(after.notes).toHaveLength(1);
      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────── isolation

  describe('isolation', () => {
    it('never returns another account’s records', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      await push(owner.access, { notes: [{ clientId: 'n1', content: 'a private thought' }] });

      const theirs = await pull(stranger.access);
      expect(theirs.notes).toHaveLength(0);
      expect(theirs.reminders).toHaveLength(0);
    });

    it('cannot be made to touch another account’s record by its client id', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      await push(owner.access, { notes: [{ clientId: 'shared', content: 'mine' }] });

      // A client id is scoped to the account by a database constraint, so
      // this creates a different row rather than reaching the first.
      const result = await push(stranger.access, {
        notes: [{ clientId: 'shared', content: 'theirs' }],
      });
      expect(result.notes[0].outcome).toBe('created');

      const mine = await prisma.note.findFirstOrThrow({
        where: { userId: owner.userId, clientId: 'shared' },
      });
      expect(mine.content).toBe('mine');
      expect(result.notes[0].id).not.toBe(mine.id);
    });

    it('cannot delete another account’s record by its client id', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      await push(owner.access, { notes: [{ clientId: 'target', content: 'mine' }] });

      const result = await push(stranger.access, {
        notes: [{ clientId: 'target', deleted: true }],
      });
      expect(result.notes[0].outcome).toBe('unchanged');

      const mine = await prisma.note.findFirstOrThrow({
        where: { userId: owner.userId, clientId: 'target' },
      });
      expect(mine.deletedAt).toBeNull();
    });

    it('requires authentication', async () => {
      await request(http()).get('/api/v1/sync/pull').expect(401);
      await request(http()).post('/api/v1/sync/push').send({}).expect(401);
      await request(http()).get('/api/v1/sync/status').expect(401);
      await request(http()).post('/api/v1/sync/reset').expect(401);
    });
  });

  // ──────────────────────────────────────────────────────────── status

  describe('status', () => {
    it('reports totals, how far behind this device is, and the tombstone window', async () => {
      const account = await newAccount();
      await push(account.access, {
        notes: [{ clientId: 'n1', content: 'one' }],
        reminders: [{ clientId: 'r1', text: 'gym', dueAt: '2030-01-05T09:00' }],
      });

      const res = await request(http())
        .get('/api/v1/sync/status')
        .set(auth(account.access))
        .expect(200);
      const body = (res.body as Envelope<{
        totals: { notes: number; reminders: number };
        pending: { notes: number; reminders: number };
        tombstoneDays: number;
        lastPushedAt: string | null;
      }>).data;

      expect(body.totals).toEqual({ notes: 1, reminders: 1 });
      // Nothing pulled yet, so both are outstanding.
      expect(body.pending.notes).toBe(1);
      expect(body.lastPushedAt).not.toBeNull();
      // The window is published, because it is how long a device may be
      // offline and still sync correctly.
      expect(body.tombstoneDays).toBeGreaterThan(0);
    });
  });
});
