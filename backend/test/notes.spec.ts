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

interface NoteView {
  id: string;
  title: string | null;
  content: string;
  pinned: boolean;
  source: string;
  language: string | null;
  clientId: string | null;
  version: number;
  updatedByDeviceId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface Page<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; pageCount: number; hasNext: boolean };
}

describe('notes', () => {
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
      .send({ email: uniqueEmail('notes'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
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
        device: { platform: 'WINDOWS', name: 'Desktop', deviceType: 'desktop' },
      })
      .expect(200);
    const body = res.body as AuthBody;
    return { deviceId: body.data.device.id, access: body.data.tokens.accessToken! };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function create(token: string, body: Record<string, unknown>) {
    const res = await request(http())
      .post('/api/v1/notes')
      .set(auth(token))
      .send(body)
      .expect(201);
    return (res.body as Envelope<NoteView>).data;
  }

  // ───────────────────────────────────────────────────────────────── CRUD

  describe('create, read, update, delete', () => {
    it('creates a note and records which device made it', async () => {
      const account = await newAccount();

      const note = await create(account.access, {
        title: 'Shopping',
        content: 'Oat milk, bread',
        pinned: true,
        language: 'en-IN',
      });

      expect(note.title).toBe('Shopping');
      expect(note.content).toBe('Oat milk, bread');
      expect(note.pinned).toBe(true);
      expect(note.source).toBe('MANUAL');
      expect(note.version).toBe(1);
      // So a syncing client can tell its own echo from somebody else's edit.
      expect(note.updatedByDeviceId).toBe(account.deviceId);
      expect(note.deletedAt).toBeNull();
    });

    it('creates a note with no title, rather than inventing one', async () => {
      const account = await newAccount();
      const note = await create(account.access, { content: 'remember the thing' });
      // A dictated note has no title, and guessing one from the first few
      // words would put the assistant's words in the user's data.
      expect(note.title).toBeNull();
    });

    it('reads one back', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'a note' });

      const res = await request(http())
        .get(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<NoteView>).data.content).toBe('a note');
    });

    it('updates and bumps the version', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'first' });

      const res = await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'second', pinned: true })
        .expect(200);

      const updated = (res.body as Envelope<NoteView>).data;
      expect(updated.content).toBe('second');
      expect(updated.pinned).toBe(true);
      expect(updated.version).toBe(2);
    });

    it('soft-deletes, so the deletion can reach other devices', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'to go' });

      await request(http())
        .delete(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .expect(200);

      // Gone from the API...
      await request(http())
        .get(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .expect(404);

      // ...but still on disk, marked, with its version bumped so the next
      // sync carries the deletion.
      const row = await prisma.note.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.version).toBe(2);
    });

    it('restores a deleted note', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'oops' });
      await request(http())
        .delete(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .expect(200);

      const res = await request(http())
        .post(`/api/v1/notes/${created.id}/restore`)
        .set(auth(account.access))
        .expect(201);
      expect((res.body as Envelope<NoteView>).data.deletedAt).toBeNull();
    });

    it('rejects a malformed id before touching the database', async () => {
      const account = await newAccount();
      await request(http())
        .get('/api/v1/notes/not-a-uuid')
        .set(auth(account.access))
        .expect(400);
    });

    it('rejects empty or oversized content', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/notes')
        .set(auth(account.access))
        .send({ content: '' })
        .expect(400);
      await request(http())
        .post('/api/v1/notes')
        .set(auth(account.access))
        .send({ content: 'x'.repeat(10_001) })
        .expect(400);
    });

    it('rejects unknown fields rather than ignoring them', async () => {
      const account = await newAccount();
      await request(http())
        .post('/api/v1/notes')
        .set(auth(account.access))
        .send({ content: 'x', userId: 'someone-else' })
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────── idempotency

  describe('idempotent creation', () => {
    it('updates rather than duplicating when a client id repeats', async () => {
      const account = await newAccount();

      const first = await create(account.access, { content: 'offline note', clientId: 'local-1' });
      const second = await create(account.access, { content: 'offline note, edited', clientId: 'local-1' });

      // The same row. This is what makes an offline device's queue safe to
      // replay after a dropped connection.
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('offline note, edited');
      expect(second.version).toBe(2);
      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(1);
    });

    it('treats a repeat with no client id as a genuinely new note', async () => {
      const account = await newAccount();
      await create(account.access, { content: 'same words' });
      await create(account.access, { content: 'same words' });
      expect(await prisma.note.count({ where: { userId: account.userId } })).toBe(2);
    });

    it('scopes a client id to the account', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();

      const mine = await create(owner.access, { content: 'mine', clientId: 'shared-id' });
      const theirs = await create(stranger.access, { content: 'theirs', clientId: 'shared-id' });

      // A client id is not a capability: one user's `shared-id` is a
      // different row from another's.
      expect(theirs.id).not.toBe(mine.id);
      expect(theirs.content).toBe('theirs');
    });

    it('brings back a note the client had deleted locally', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'note', clientId: 'local-2' });
      await request(http())
        .delete(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .expect(200);

      // An offline device recreating it is asking for it back, not asking
      // for a second copy.
      const again = await create(account.access, { content: 'note again', clientId: 'local-2' });
      expect(again.id).toBe(created.id);
      expect(again.deletedAt).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────── conflicts

  describe('conflicts', () => {
    it('refuses an edit built on a stale version and overwrites nothing', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'original' });

      // Another device gets there first.
      await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'theirs' })
        .expect(200);

      const res = await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'mine', expectedVersion: 1 })
        .expect(409);

      const body = res.body as ErrorBody & { details?: { field: string; message: string }[] };
      expect(body.message).toContain('Nothing was overwritten');
      expect(body.details?.[0].message).toContain('expected 1, stored 2');

      // The other device's change survived.
      const row = await prisma.note.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.content).toBe('theirs');
      expect(row.version).toBe(2);
    });

    it('applies an edit whose base version is current', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'original' });

      const res = await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'edited', expectedVersion: 1 })
        .expect(200);
      expect((res.body as Envelope<NoteView>).data.version).toBe(2);
    });

    it('lets a client overwrite deliberately by omitting the version', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'original' });
      await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'theirs' })
        .expect(200);

      // Omitting expectedVersion is a deliberate "take mine" — the only
      // way to win a conflict, which makes overwriting an explicit act.
      const res = await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'mine' })
        .expect(200);
      expect((res.body as Envelope<NoteView>).data.content).toBe('mine');
    });

    it('refuses a delete built on a stale version', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'original' });
      await request(http())
        .patch(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .send({ content: 'changed' })
        .expect(200);

      await request(http())
        .delete(`/api/v1/notes/${created.id}?expectedVersion=1`)
        .set(auth(account.access))
        .expect(409);

      const row = await prisma.note.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.deletedAt).toBeNull();
    });
  });

  // ───────────────────────────────────────── listing, search, pagination

  describe('listing, search, sorting and filtering', () => {
    async function seed(token: string) {
      await create(token, { title: 'Groceries', content: 'oat milk and bread', pinned: true });
      await create(token, { title: 'Work', content: 'finish the report', language: 'en-IN' });
      await create(token, { content: 'मुझे दूध खरीदना है', language: 'hi-IN' });
      await create(token, { title: 'Ideas', content: 'a better mousetrap', source: 'VOICE' });
    }

    it('lists with pinned first by default', async () => {
      const account = await newAccount();
      await seed(account.access);

      const res = await request(http())
        .get('/api/v1/notes')
        .set(auth(account.access))
        .expect(200);
      const page = (res.body as Envelope<Page<NoteView>>).data;

      expect(page.meta.total).toBe(4);
      expect(page.items[0].pinned).toBe(true);
    });

    it('can be told not to float pinned notes', async () => {
      const account = await newAccount();
      await seed(account.access);

      const res = await request(http())
        .get('/api/v1/notes?pinnedFirst=false&sortBy=createdAt&order=asc')
        .set(auth(account.access))
        .expect(200);
      const page = (res.body as Envelope<Page<NoteView>>).data;
      expect(page.items[0].title).toBe('Groceries');
      expect(page.items.at(-1)!.title).toBe('Ideas');
    });

    it('searches title and content, case-insensitively', async () => {
      const account = await newAccount();
      await seed(account.access);

      const byContent = await request(http())
        .get('/api/v1/notes?q=REPORT')
        .set(auth(account.access))
        .expect(200);
      expect((byContent.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);

      const byTitle = await request(http())
        .get('/api/v1/notes?q=grocer')
        .set(auth(account.access))
        .expect(200);
      expect((byTitle.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);
    });

    it('searches Devanagari as well as Latin script', async () => {
      const account = await newAccount();
      await seed(account.access);

      const res = await request(http())
        .get(`/api/v1/notes?q=${encodeURIComponent('दूध')}`)
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);
    });

    it('filters by pinned, source and language', async () => {
      const account = await newAccount();
      await seed(account.access);

      const pinned = await request(http())
        .get('/api/v1/notes?pinned=true')
        .set(auth(account.access))
        .expect(200);
      expect((pinned.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);

      const voice = await request(http())
        .get('/api/v1/notes?source=VOICE')
        .set(auth(account.access))
        .expect(200);
      expect((voice.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);

      const hindi = await request(http())
        .get('/api/v1/notes?language=hi-IN')
        .set(auth(account.access))
        .expect(200);
      expect((hindi.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);
    });

    it('filters by a date range', async () => {
      const account = await newAccount();
      const note = await create(account.access, { content: 'dated' });

      const future = new Date(Date.now() + 86_400_000).toISOString();
      const past = new Date(Date.now() - 86_400_000).toISOString();

      const inRange = await request(http())
        .get(`/api/v1/notes?dateField=createdAt&from=${past}&to=${future}`)
        .set(auth(account.access))
        .expect(200);
      expect((inRange.body as Envelope<Page<NoteView>>).data.items.map((n) => n.id)).toContain(note.id);

      const outOfRange = await request(http())
        .get(`/api/v1/notes?dateField=createdAt&from=${future}`)
        .set(auth(account.access))
        .expect(200);
      expect((outOfRange.body as Envelope<Page<NoteView>>).data.meta.total).toBe(0);
    });

    it('paginates', async () => {
      const account = await newAccount();
      for (let i = 0; i < 7; i += 1) {
        await create(account.access, { content: `note ${i}` });
      }

      const first = await request(http())
        .get('/api/v1/notes?limit=3&page=1')
        .set(auth(account.access))
        .expect(200);
      const firstPage = (first.body as Envelope<Page<NoteView>>).data;
      expect(firstPage.items).toHaveLength(3);
      expect(firstPage.meta.total).toBe(7);
      expect(firstPage.meta.pageCount).toBe(3);
      expect(firstPage.meta.hasNext).toBe(true);

      const last = await request(http())
        .get('/api/v1/notes?limit=3&page=3')
        .set(auth(account.access))
        .expect(200);
      expect((last.body as Envelope<Page<NoteView>>).data.items).toHaveLength(1);
    });

    it('caps the page size', async () => {
      const account = await newAccount();
      await request(http())
        .get('/api/v1/notes?limit=5000')
        .set(auth(account.access))
        .expect(400);
    });

    it('hides deleted notes unless asked', async () => {
      const account = await newAccount();
      const created = await create(account.access, { content: 'gone' });
      await request(http())
        .delete(`/api/v1/notes/${created.id}`)
        .set(auth(account.access))
        .expect(200);

      const hidden = await request(http())
        .get('/api/v1/notes')
        .set(auth(account.access))
        .expect(200);
      expect((hidden.body as Envelope<Page<NoteView>>).data.meta.total).toBe(0);

      const shown = await request(http())
        .get('/api/v1/notes?includeDeleted=true')
        .set(auth(account.access))
        .expect(200);
      expect((shown.body as Envelope<Page<NoteView>>).data.meta.total).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────── isolation

  describe('user and device isolation', () => {
    it('hides another account’s note entirely', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const note = await create(owner.access, { content: 'private' });

      // 404, not 403: confirming an id exists is itself a disclosure.
      await request(http()).get(`/api/v1/notes/${note.id}`).set(auth(stranger.access)).expect(404);
      await request(http())
        .patch(`/api/v1/notes/${note.id}`)
        .set(auth(stranger.access))
        .send({ content: 'mine now' })
        .expect(404);
      await request(http())
        .delete(`/api/v1/notes/${note.id}`)
        .set(auth(stranger.access))
        .expect(404);
      await request(http())
        .post(`/api/v1/notes/${note.id}/restore`)
        .set(auth(stranger.access))
        .expect(404);

      const row = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
      expect(row.content).toBe('private');
      expect(row.deletedAt).toBeNull();
    });

    it('never lists another account’s notes', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      await create(owner.access, { content: 'a private thought' });

      const res = await request(http())
        .get('/api/v1/notes?q=private')
        .set(auth(stranger.access))
        .expect(200);
      expect((res.body as Envelope<Page<NoteView>>).data.meta.total).toBe(0);
    });

    it('lets any of the account’s own devices work on its notes', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);
      const note = await create(account.access, { content: 'shared across my devices' });

      // Notes belong to the account, not to a device — unlike a voice
      // session or a pending action, which belong to the screen they
      // appeared on.
      const res = await request(http())
        .patch(`/api/v1/notes/${note.id}`)
        .set(auth(other.access))
        .send({ content: 'edited on the desktop' })
        .expect(200);

      const updated = (res.body as Envelope<NoteView>).data;
      expect(updated.content).toBe('edited on the desktop');
      expect(updated.updatedByDeviceId).toBe(other.deviceId);
    });

    it('requires authentication on every route', async () => {
      const id = '4f1e2d3c-0000-4000-8000-000000000000';
      await request(http()).get('/api/v1/notes').expect(401);
      await request(http()).post('/api/v1/notes').send({ content: 'x' }).expect(401);
      await request(http()).get(`/api/v1/notes/${id}`).expect(401);
      await request(http()).patch(`/api/v1/notes/${id}`).send({ content: 'x' }).expect(401);
      await request(http()).delete(`/api/v1/notes/${id}`).expect(401);
    });
  });

  // ───────────────────────────────────────────────────────── retention

  describe('retention', () => {
    it('purges a note deleted past the window and keeps a recent one', async () => {
      const account = await newAccount();
      const { NotesService } = await import('../src/modules/notes/notes.service');
      const notes = app.get(NotesService);

      const old = await create(account.access, { content: 'long gone' });
      const recent = await create(account.access, { content: 'just deleted' });

      for (const id of [old.id, recent.id]) {
        await request(http()).delete(`/api/v1/notes/${id}`).set(auth(account.access)).expect(200);
      }
      await prisma.note.update({
        where: { id: old.id },
        data: { deletedAt: new Date(Date.now() - 60 * 86_400_000) },
      });

      expect(await notes.purgeDeleted(30)).toBeGreaterThanOrEqual(1);

      expect(await prisma.note.findUnique({ where: { id: old.id } })).toBeNull();
      // Still there: the window is also how long a device may be offline
      // and still learn that something was deleted.
      expect(await prisma.note.findUnique({ where: { id: recent.id } })).not.toBeNull();
    });

    it('does nothing when retention is disabled', async () => {
      const { NotesService } = await import('../src/modules/notes/notes.service');
      expect(await app.get(NotesService).purgeDeleted(0)).toBe(0);
    });
  });
});
