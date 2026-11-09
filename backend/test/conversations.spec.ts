import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type Envelope,
  type ErrorBody,
} from './helpers/app';

interface ConversationRow {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
  messageCount: number;
}

describe('conversations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;
  let conversations: ConversationsService;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
    conversations = app.get(ConversationsService);
  });
  afterAll(async () => {
    await app?.close();
  });

  async function newAccount() {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('conv'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return { userId: body.data.user.id, access: body.data.tokens.accessToken! };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('lifecycle', () => {
    it('creates, lists and renames', async () => {
      const account = await newAccount();

      const created = await request(http())
        .post('/api/v1/conversations')
        .set(auth(account.access))
        .send({ title: 'Monday planning' })
        .expect(201);
      const id = (created.body as Envelope<ConversationRow>).data.id;

      const listed = await request(http())
        .get('/api/v1/conversations')
        .set(auth(account.access))
        .expect(200);
      const items = (listed.body as Envelope<{ items: ConversationRow[] }>).data.items;
      expect(items.map((c) => c.id)).toContain(id);
      expect(items.find((c) => c.id === id)!.messageCount).toBe(0);

      const renamed = await request(http())
        .patch(`/api/v1/conversations/${id}`)
        .set(auth(account.access))
        .send({ title: 'Tuesday planning' })
        .expect(200);
      expect((renamed.body as Envelope<ConversationRow>).data.title).toBe('Tuesday planning');
    });

    it('archives without deleting', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);

      const res = await request(http())
        .post(`/api/v1/conversations/${conversation.id}/archive`)
        .set(auth(account.access))
        .expect(201);
      expect((res.body as Envelope<ConversationRow>).data.archivedAt).not.toBeNull();

      // Still readable: archiving is a view decision, not a deletion.
      await request(http())
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(account.access))
        .expect(200);
    });

    it('soft-deletes and does not claim the data is already gone', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);

      await request(http())
        .delete(`/api/v1/conversations/${conversation.id}`)
        .set(auth(account.access))
        .expect(200);

      // Gone from the API at once...
      await request(http())
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(account.access))
        .expect(404);

      // ...but still on disk until the purge job runs, which is what makes
      // an accidental delete recoverable.
      const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('deletes every conversation for the account', async () => {
      const account = await newAccount();
      await conversations.create(account.userId);
      await conversations.create(account.userId);

      const res = await request(http())
        .delete('/api/v1/conversations')
        .set(auth(account.access))
        .expect(200);
      expect((res.body as Envelope<{ deleted: number }>).data.deleted).toBe(2);

      const listed = await request(http())
        .get('/api/v1/conversations')
        .set(auth(account.access))
        .expect(200);
      expect((listed.body as Envelope<{ items: ConversationRow[] }>).data.items).toHaveLength(0);
    });
  });

  describe('messages and the context window', () => {
    it('moves the conversation cursor when a message is appended', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);
      expect(conversation.lastMessageAt).toBeNull();

      const message = await conversations.appendMessage(conversation.id, 'USER', 'hello');
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.lastMessageAt?.toISOString()).toBe(message.createdAt.toISOString());
    });

    it('returns recent turns oldest first, capped', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);
      for (const n of [1, 2, 3, 4, 5]) {
        await conversations.appendMessage(conversation.id, n % 2 ? 'USER' : 'ASSISTANT', `turn ${n}`);
      }

      const window = await conversations.contextWindow(account.userId, conversation.id, 3);
      expect(window.map((m) => m.content)).toEqual(['turn 3', 'turn 4', 'turn 5']);
      expect(window.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    });

    it('excludes system messages from the window', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);
      await conversations.appendMessage(conversation.id, 'SYSTEM', 'you are a helpful assistant');
      await conversations.appendMessage(conversation.id, 'USER', 'hello');

      const window = await conversations.contextWindow(account.userId, conversation.id, 10);
      // The system instruction is built fresh each turn; a stored row must
      // not be able to influence it.
      expect(window.map((m) => m.content)).toEqual(['hello']);
    });

    it('returns nothing for a zero or negative limit', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);
      await conversations.appendMessage(conversation.id, 'USER', 'hello');

      expect(await conversations.contextWindow(account.userId, conversation.id, 0)).toEqual([]);
      expect(await conversations.contextWindow(account.userId, conversation.id, -5)).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('reports another account’s conversation as missing, not forbidden', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const conversation = await conversations.create(owner.userId);

      for (const path of [
        `/api/v1/conversations/${conversation.id}`,
        `/api/v1/conversations/${conversation.id}/messages`,
      ]) {
        const res = await request(http()).get(path).set(auth(stranger.access)).expect(404);
        expect((res.body as ErrorBody).success).toBe(false);
      }

      await request(http())
        .patch(`/api/v1/conversations/${conversation.id}`)
        .set(auth(stranger.access))
        .send({ title: 'mine now' })
        .expect(404);
      await request(http())
        .delete(`/api/v1/conversations/${conversation.id}`)
        .set(auth(stranger.access))
        .expect(404);
    });

    it('returns an empty window for a conversation the user does not own', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const conversation = await conversations.create(owner.userId);
      await conversations.appendMessage(conversation.id, 'USER', 'my private note');

      // A conversation id alone is never enough: the query joins back to
      // the owner, so a leaked id yields nothing.
      expect(await conversations.contextWindow(stranger.userId, conversation.id, 10)).toEqual([]);
    });

    it('does not include a deleted conversation in the window', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);
      await conversations.appendMessage(conversation.id, 'USER', 'before deletion');
      await conversations.remove(account.userId, conversation.id);

      expect(await conversations.contextWindow(account.userId, conversation.id, 10)).toEqual([]);
    });

    it('requires authentication', async () => {
      await request(http()).get('/api/v1/conversations').expect(401);
      await request(http()).post('/api/v1/conversations').send({}).expect(401);
    });

    it('rejects a malformed id before touching the database', async () => {
      const account = await newAccount();
      await request(http())
        .get('/api/v1/conversations/not-a-uuid')
        .set(auth(account.access))
        .expect(400);
    });
  });

  describe('retention', () => {
    it('removes conversations older than the window and keeps newer ones', async () => {
      const account = await newAccount();
      const old = await conversations.create(account.userId, 'old');
      const fresh = await conversations.create(account.userId, 'fresh');

      await prisma.conversation.update({
        where: { id: old.id },
        data: { lastMessageAt: new Date(Date.now() - 40 * 86_400_000) },
      });
      await prisma.conversation.update({
        where: { id: fresh.id },
        data: { lastMessageAt: new Date() },
      });

      expect(await conversations.applyRetention(account.userId, 30)).toBe(1);
      const rows = await prisma.conversation.findMany({
        where: { userId: account.userId },
        select: { id: true, deletedAt: true },
      });
      expect(rows.find((r) => r.id === old.id)!.deletedAt).not.toBeNull();
      expect(rows.find((r) => r.id === fresh.id)!.deletedAt).toBeNull();
    });

    it('does nothing when retention is disabled', async () => {
      const account = await newAccount();
      const conversation = await conversations.create(account.userId);
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(0) },
      });

      expect(await conversations.applyRetention(account.userId, 0)).toBe(0);
    });
  });
});
