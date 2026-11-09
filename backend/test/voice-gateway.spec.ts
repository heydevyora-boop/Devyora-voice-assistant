import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { LlmRegistry } from '../src/providers/llm/llm.module';
import { VoiceEventBus } from '../src/modules/voice/voice-event-bus';
import { createTestApp, uniqueEmail, STRONG_PASSWORD, NATIVE_DEVICE, type AuthBody, type Envelope } from './helpers/app';

interface Connected {
  userId: string;
  deviceId: string;
}

/**
 * The socket transport, against a genuinely listening server.
 *
 * These tests use a real socket.io client over a real port. A mocked socket
 * would prove that the gateway's methods return the right objects, which is
 * not the question: the question is whether a client that connects, is
 * authenticated, joins rooms and then drops actually receives what it
 * should.
 */
describe('voice gateway', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  /** The same server instance Nest serves from, typed. */
  let http: () => Server;
  let url: string;
  let llm: { reset: () => unknown; script: (r: RegExp, o: unknown) => unknown };
  const open: Socket[] = [];

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
    // socket.io attaches on listen, so the test server really listens.
    await app.listen(0);
    const address = http().address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/assistant`;
    llm = app.get(LlmRegistry).byId('mock') as never;
  }, 60_000);

  afterAll(async () => {
    for (const socket of open) socket.close();
    await app?.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  afterEach(() => {
    while (open.length) open.pop()!.close();
  });

  async function newAccount() {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('ws'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return {
      email: body.data.user.email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
    };
  }

  function connect(token: string | null): Socket {
    const socket = io(url, {
      transports: ['websocket'],
      // The handshake, never a query string: a URL ends up in logs.
      auth: token ? { token } : {},
      reconnection: false,
      forceNew: true,
    });
    open.push(socket);
    return socket;
  }

  function once<T>(socket: Socket, event: string, timeoutMs = 8_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  function emit<T>(socket: Socket, event: string, body: unknown, timeoutMs = 8_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for "${event}"`)), timeoutMs);
      socket.emit(event, body, (reply: T) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // ───────────────────────────────────────────────────── authentication

  describe('authentication', () => {
    it('accepts a valid access token and reports the identity it established', async () => {
      const account = await newAccount();
      const socket = connect(account.access);

      const connected = await once<Connected>(socket, 'connected');
      expect(connected.userId).toBe(account.userId);
      expect(connected.deviceId).toBe(account.deviceId);
    }, 20_000);

    it('disconnects a socket with no credential', async () => {
      const socket = connect(null);

      const error = await once<{ code: string }>(socket, 'error');
      expect(error.code).toBe('UNAUTHENTICATED');

      // And it is actually dropped, not merely told off.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(socket.connected).toBe(false);
    }, 20_000);

    it('disconnects a socket with a bad credential, saying nothing about why', async () => {
      const socket = connect('not.a.real.token');

      const error = await once<{ code: string }>(socket, 'error');
      // Uniform, like the HTTP 401: a caller holding a stale token learns
      // nothing about account or device state.
      expect(error.code).toBe('UNAUTHENTICATED');
    }, 20_000);

    it('applies the same checks as HTTP, so a revoked device cannot connect', async () => {
      const account = await newAccount();
      // The credential is good; the device is not. Both transports consult
      // one implementation, so this cannot drift.
      await prisma.device.update({
        where: { id: account.deviceId },
        data: { revokedAt: new Date() },
      });

      const socket = connect(account.access);
      const error = await once<{ code: string }>(socket, 'error');
      expect(error.code).toBe('UNAUTHENTICATED');
    }, 20_000);
  });

  // ────────────────────────────────────────────────────────── delivery

  describe('event delivery', () => {
    it('pushes a device-private event to the device that is speaking', async () => {
      const account = await newAccount();
      const socket = connect(account.access);
      await once(socket, 'connected');

      const bus = app.get(VoiceEventBus);
      const waiting = once<{ type: string; text: string }>(socket, 'transcript.final');

      bus.publish(
        {
          type: 'transcript.final',
          sessionId: '00000000-0000-4000-8000-000000000000',
          seq: 1,
          at: new Date().toISOString(),
          text: 'buy milk',
          detectedLanguage: 'en-IN',
          confidence: null,
          durationMs: null,
          provider: { id: 'mock', isMock: true },
        },
        {
          userId: account.userId,
          deviceId: account.deviceId,
          sessionId: '00000000-0000-4000-8000-000000000000',
          deviceOnly: true,
        },
      );

      const event = await waiting;
      expect(event.text).toBe('buy milk');
    }, 20_000);

    it('delivers an account-wide event to a device that is not the speaker', async () => {
      const account = await newAccount();
      const socket = connect(account.access);
      await once(socket, 'connected');

      const bus = app.get(VoiceEventBus);
      const waiting = once<{ pendingActionId: string }>(socket, 'confirmation.required');

      bus.publish(
        {
          type: 'confirmation.required',
          sessionId: '00000000-0000-4000-8000-000000000001',
          seq: 2,
          at: new Date().toISOString(),
          pendingActionId: 'abc',
          kind: 'MESSAGE_WHATSAPP',
          intent: 'send_message',
          fields: [],
          expiresAt: new Date().toISOString(),
        },
        {
          userId: account.userId,
          // A different device started the turn; the confirmation still
          // reaches this screen, because the person may be looking at it.
          deviceId: 'another-device',
          sessionId: '00000000-0000-4000-8000-000000000001',
        },
      );

      expect((await waiting).pendingActionId).toBe('abc');
    }, 20_000);

    it('does not leak one account’s events to another', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();

      const strangerSocket = connect(stranger.access);
      await once(strangerSocket, 'connected');

      let leaked = false;
      strangerSocket.onAny(() => {
        leaked = true;
      });

      app.get(VoiceEventBus).publish(
        {
          type: 'response.ready',
          sessionId: '00000000-0000-4000-8000-000000000002',
          seq: 1,
          at: new Date().toISOString(),
          text: 'a private answer',
          intent: 'save_note',
          status: 'queued_for_execution',
          speech: null,
          speechUnavailable: null,
        },
        {
          userId: owner.userId,
          deviceId: owner.deviceId,
          sessionId: '00000000-0000-4000-8000-000000000002',
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(leaked).toBe(false);
    }, 20_000);
  });

  // ────────────────────────────────────────────────────── reconnection

  describe('reconnection', () => {
    it('replays what a client missed while it was gone', async () => {
      const account = await newAccount();
      llm.script(/.*/, {
        command: { intent: 'save_note', entities: { text: 'buy milk' } },
        confidence: 0.95,
        clarification: null,
        reply: 'Saved it.',
        detectedLanguage: 'en-IN',
      });

      // A turn runs while no socket is attached at all.
      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ inputMode: 'TEXT' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;

      await request(http())
        .post(`/api/v1/voice/sessions/${sessionId}/transcript`)
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ text: 'note: buy milk' })
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Now the client connects and asks for everything.
      const socket = connect(account.access);
      await once(socket, 'connected');

      const replay = await emit<{
        ok: boolean;
        session?: { state: string };
        events?: { type: string; seq: number }[];
      }>(socket, 'voice.resume', { sessionId, afterSeq: 0 });

      expect(replay.ok).toBe(true);
      expect(replay.session!.state).toBe('QUEUED');
      const types = replay.events!.map((e) => e.type);
      expect(types).toContain('transcript.final');
      expect(types).toContain('response.ready');
      // Nothing was re-run: these were recorded as they happened.
      expect(replay.events!.map((e) => e.seq)).toEqual(replay.events!.map((_, i) => i + 1));
    }, 30_000);

    it('returns only events after the sequence the client holds', async () => {
      const account = await newAccount();
      llm.script(/.*/, {
        command: { intent: 'save_note', entities: { text: 'x' } },
        confidence: 0.9,
        clarification: null,
        reply: 'Saved.',
        detectedLanguage: 'en-IN',
      });

      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ inputMode: 'TEXT' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;
      await request(http())
        .post(`/api/v1/voice/sessions/${sessionId}/transcript`)
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ text: 'note: x' })
        .expect(201);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const socket = connect(account.access);
      await once(socket, 'connected');

      const all = await emit<{ events: unknown[] }>(socket, 'voice.resume', { sessionId, afterSeq: 0 });
      const partial = await emit<{ events: { seq: number }[] }>(socket, 'voice.resume', {
        sessionId,
        afterSeq: 2,
      });

      expect(partial.events).toHaveLength(all.events.length - 2);
      expect(partial.events[0].seq).toBe(3);
    }, 30_000);

    it('will not replay another account’s session', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();

      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${owner.access}` })
        .send({ inputMode: 'TEXT' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;

      const socket = connect(stranger.access);
      await once(socket, 'connected');

      const reply = await emit<{ ok: boolean; code: string }>(socket, 'voice.resume', {
        sessionId,
        afterSeq: 0,
      });
      // Reads as missing, as it does over HTTP.
      expect(reply.ok).toBe(false);
      expect(reply.code).toBe('NOT_FOUND');
    }, 30_000);

    it('will not replay a session belonging to another device', async () => {
      const account = await newAccount();
      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ inputMode: 'TEXT' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;

      // Same account, second device.
      const second = await request(http())
        .post('/api/v1/auth/login')
        .send({
          email: account.email,
          password: STRONG_PASSWORD,
          device: { platform: 'MACOS', name: 'Laptop', deviceType: 'laptop' },
        })
        .expect(200);
      const otherToken = (second.body as AuthBody).data.tokens.accessToken!;

      const socket = connect(otherToken);
      await once(socket, 'connected');

      const reply = await emit<{ ok: boolean; code: string }>(socket, 'voice.resume', {
        sessionId,
        afterSeq: 0,
      });
      expect(reply.ok).toBe(false);
      expect(reply.code).toBe('NOT_FOUND');
    }, 30_000);

    it('rejects a malformed resume request', async () => {
      const account = await newAccount();
      const socket = connect(account.access);
      await once(socket, 'connected');

      // A literal `null` payload is not in this list: socket.io does not
      // deliver an acknowledgement for one, so there is nothing to assert.
      // It changes no state either — `parseResume` rejects it like any
      // other unusable body.
      for (const body of [{}, { sessionId: 'not-a-uuid' }, 'string', { sessionId: 42 }, []]) {
        const reply = await emit<{ ok: boolean; code: string }>(socket, 'voice.resume', body);
        expect(reply.ok).toBe(false);
        expect(reply.code).toBe('BAD_REQUEST');
      }
    }, 30_000);
  });

  // ──────────────────────────────────────────────────── client messages

  describe('client messages', () => {
    it('relays a partial transcript without storing it', async () => {
      const account = await newAccount();
      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ inputMode: 'TEXT' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;

      const socket = connect(account.access);
      await once(socket, 'connected');

      const waiting = once<{ text: string; isMock: boolean }>(socket, 'transcript.partial');
      const ack = await emit<{ ok: boolean }>(socket, 'voice.transcript.partial', {
        sessionId,
        text: 'buy mi',
      });
      expect(ack.ok).toBe(true);

      const event = await waiting;
      expect(event.text).toBe('buy mi');

      await new Promise((resolve) => setTimeout(resolve, 200));
      const stored = await prisma.voiceSessionEvent.findMany({
        where: { voiceSessionId: sessionId },
        select: { type: true },
      });
      expect(stored.map((e) => e.type)).not.toContain('transcript.partial');
    }, 30_000);

    it('cancels a session over the socket', async () => {
      const account = await newAccount();
      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ inputMode: 'UPLOAD' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;

      const socket = connect(account.access);
      await once(socket, 'connected');

      const ack = await emit<{ ok: boolean }>(socket, 'voice.cancel', { sessionId, afterSeq: 0 });
      expect(ack.ok).toBe(true);

      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.state).toBe('CANCELLED');
    }, 30_000);

    it('refuses audio frames, and says where audio goes instead', async () => {
      const account = await newAccount();
      const socket = connect(account.access);
      await once(socket, 'connected');

      const reply = await emit<{ ok: boolean; code: string; detail: string }>(
        socket,
        'voice.audio.chunk',
        { sessionId: '00000000-0000-4000-8000-000000000000', chunk: 'AAAA' },
      );

      // Stated refusal rather than silence: continuous microphone audio
      // does not go to the cloud. Wake-word detection is the device's job.
      expect(reply.ok).toBe(false);
      expect(reply.code).toBe('UNSUPPORTED');
      expect(reply.detail).toContain('/audio');
    }, 30_000);

    it('does not cancel a session when a socket simply drops', async () => {
      const account = await newAccount();
      const started = await request(http())
        .post('/api/v1/voice/sessions')
        .set({ Authorization: `Bearer ${account.access}` })
        .send({ inputMode: 'UPLOAD' })
        .expect(201);
      const sessionId = (started.body as Envelope<{ id: string }>).data.id;

      const socket = connect(account.access);
      await once(socket, 'connected');
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The user may be reconnecting, and the turn they started should
      // still be there when they do.
      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.state).toBe('LISTENING');
      expect(row.endedAt).toBeNull();
    }, 30_000);
  });
});
