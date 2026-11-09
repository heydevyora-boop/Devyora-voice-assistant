import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import { SttRegistry } from '../src/providers/stt/stt.module';
import { TtsRegistry } from '../src/providers/tts/tts.module';
import type { MockSttProvider } from '../src/providers/stt/mock.provider';
import type { MockTtsProvider } from '../src/providers/tts/mock.provider';
import { SttError } from '../src/providers/stt/errors';
import { AudioStoreService } from '../src/modules/voice/audio/audio-store.service';
import { VoiceService } from '../src/modules/voice/voice.service';
import {
  canTransition,
  isTerminal,
  TERMINAL_STATES,
  VoiceSessionService,
} from '../src/modules/voice/voice-session.service';
import { stateForTurn } from '../src/modules/voice/voice.service';
import { EPHEMERAL_EVENTS, VOICE_EVENTS } from '../src/modules/voice/voice-events';
import {
  createTestApp,
  uniqueEmail,
  STRONG_PASSWORD,
  NATIVE_DEVICE,
  type AuthBody,
  type Envelope,
  type ErrorBody,
} from './helpers/app';
import { notAudio, wav, webm } from './helpers/audio';

interface SessionView {
  id: string;
  state: string;
  inputMode: string;
  transcript: string | null;
  detectedLanguage: string | null;
  conversationId: string | null;
  pendingActionId: string | null;
  replyText: string | null;
  failureCode: string | null;
  lastEventSeq: number;
  expiresAt: string;
  endedAt: string | null;
}

interface TurnView {
  session: SessionView;
  transcript: {
    text: string;
    detectedLanguage: string | null;
    confidence: number | null;
    provider: { id: string; isMock: boolean };
  } | null;
  assistant: { status: string; reply: string; intent: string | null; plan: { pendingActionId: string } | null } | null;
  speech: { url: string; mimeType: string; isMock: boolean } | null;
  speechUnavailable: string | null;
}

const noteOutput = (text = 'buy milk') => ({
  command: { intent: 'save_note', entities: { text } },
  confidence: 0.95,
  clarification: null,
  reply: 'Saved it.',
  detectedLanguage: 'en-IN',
});

describe('voice pipeline', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => Server;
  let stt: MockSttProvider;
  let tts: MockTtsProvider;
  let llm: { reset: () => unknown; script: (r: RegExp, o: unknown) => unknown };
  let store: AudioStoreService;
  let sessions: VoiceSessionService;
  let voice: VoiceService;

  beforeAll(async () => {
    ({ app, prisma, http } = await createTestApp());
    stt = app.get(SttRegistry).byId('mock') as MockSttProvider;
    tts = app.get(TtsRegistry).byId('mock') as MockTtsProvider;
    store = app.get(AudioStoreService);
    sessions = app.get(VoiceSessionService);
    voice = app.get(VoiceService);

    // The language model's stand-in, reached the same way.
    const { LlmRegistry } = await import('../src/providers/llm/llm.module');
    llm = app.get(LlmRegistry).byId('mock') as never;

    // The active providers really are the stand-ins under test config.
    expect(app.get(SttRegistry).active().id).toBe('mock');
    expect(app.get(TtsRegistry).active().id).toBe('mock');
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    stt.reset();
    tts.reset();
    llm.reset();
  });

  async function newAccount() {
    const res = await request(http())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('voice'), password: STRONG_PASSWORD, device: NATIVE_DEVICE })
      .expect(201);
    const body = res.body as AuthBody;
    return {
      email: body.data.user.email,
      userId: body.data.user.id,
      deviceId: body.data.device.id,
      access: body.data.tokens.accessToken!,
    };
  }

  /** A second device on the same account, with its own token. */
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

  async function startSession(token: string, body: Record<string, unknown> = {}) {
    const res = await request(http())
      .post('/api/v1/voice/sessions')
      .set(auth(token))
      .send({ inputMode: 'UPLOAD', ...body })
      .expect(201);
    return (res.body as Envelope<SessionView>).data;
  }

  async function enableVoice(userId: string, patch: Record<string, string | number | boolean>) {
    await prisma.userPreference.upsert({
      where: { userId },
      create: { userId, voice: patch },
      update: { voice: patch },
    });
  }

  // ────────────────────────────────────────────────── the state machine

  describe('session state machine', () => {
    it('lets every live state reach cancellation, failure and expiry', () => {
      // A user must always be able to stop a voice interaction, and a
      // session must never get wedged with no way out.
      const live = VOICE_EVENTS.length > 0 ? ['CREATED', 'LISTENING', 'TRANSCRIBING', 'INTERPRETING', 'AWAITING_CLARIFICATION', 'AWAITING_CONFIRMATION', 'QUEUED'] : [];
      for (const from of live) {
        for (const to of ['CANCELLED', 'FAILED', 'EXPIRED']) {
          expect(canTransition(from as never, to as never)).toBe(true);
        }
      }
    });

    it('allows nothing out of a terminal state', () => {
      for (const state of TERMINAL_STATES) {
        expect(isTerminal(state)).toBe(true);
        for (const to of ['LISTENING', 'INTERPRETING', 'COMPLETED']) {
          expect(canTransition(state, to as never)).toBe(false);
        }
      }
    });

    it('refuses a jump that skips the pipeline', () => {
      expect(canTransition('CREATED' as never, 'COMPLETED' as never)).toBe(false);
      expect(canTransition('LISTENING' as never, 'AWAITING_CONFIRMATION' as never)).toBe(false);
      expect(canTransition('TRANSCRIBING' as never, 'QUEUED' as never)).toBe(false);
    });

    it('lets an answered clarification re-enter the pipeline', () => {
      expect(canTransition('AWAITING_CLARIFICATION' as never, 'TRANSCRIBING' as never)).toBe(true);
      expect(canTransition('AWAITING_CLARIFICATION' as never, 'INTERPRETING' as never)).toBe(true);
    });

    it('maps every assistant status onto a state, exhaustively', () => {
      expect(stateForTurn('needs_clarification')).toBe('AWAITING_CLARIFICATION');
      expect(stateForTurn('awaiting_confirmation')).toBe('AWAITING_CONFIRMATION');
      expect(stateForTurn('queued_for_execution')).toBe('QUEUED');
      expect(stateForTurn('answered')).toBe('COMPLETED');
      // Understood and refused is a complete outcome, not a failure.
      expect(stateForTurn('unsupported')).toBe('COMPLETED');
      expect(stateForTurn('failed')).toBe('FAILED');
    });

    it('refuses an illegal transition at the service, not just in the table', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await expect(
        sessions.transitionTo(session.id, 'CREATED', 'COMPLETED'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const unchanged = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(unchanged.state).toBe('CREATED');
    });

    it('lets only one of two concurrent transitions win', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      const results = await Promise.allSettled([
        sessions.transitionTo(session.id, 'CREATED', 'LISTENING'),
        sessions.transitionTo(session.id, 'CREATED', 'LISTENING'),
      ]);

      // The update is conditional on the state we believed it was in, so
      // the loser gets a conflict rather than silently overwriting.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────── activation

  describe('activation', () => {
    it('opens a session and moves to listening for an audio mode', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'UPLOAD' });

      expect(session.state).toBe('LISTENING');
      expect(session.inputMode).toBe('UPLOAD');
      expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('stays at created for a device doing its own recognition', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });
      expect(session.state).toBe('CREATED');
    });

    it('refuses wake-word activation unless the account enabled it', async () => {
      const account = await newAccount();

      const refused = await request(http())
        .post('/api/v1/voice/sessions')
        .set(auth(account.access))
        .send({ inputMode: 'UPLOAD', wakeWordTriggered: true })
        .expect(403);
      expect((refused.body as ErrorBody).success).toBe(false);

      await enableVoice(account.userId, { wakeWordEnabled: true });
      const allowed = await startSession(account.access, {
        inputMode: 'UPLOAD',
        wakeWordTriggered: true,
      });
      expect(allowed.state).toBe('LISTENING');

      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: allowed.id } });
      // Recorded as a label for the user's own activity view. The access
      // token is what authorised the call, exactly as for a tap.
      expect(row.wakeWordTriggered).toBe(true);
    });

    it('takes the language hint from preferences when the client sends none', async () => {
      const account = await newAccount();
      await enableVoice(account.userId, { languageHint: 'hi-IN' });

      const session = await startSession(account.access, { inputMode: 'UPLOAD' });
      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.languageHint).toBe('hi-IN');
    });

    it('requires authentication on every voice route', async () => {
      await request(http()).get('/api/v1/voice/capabilities').expect(401);
      await request(http()).post('/api/v1/voice/sessions').send({ inputMode: 'TEXT' }).expect(401);
      await request(http())
        .post('/api/v1/voice/sessions/4f1e2d3c-0000-4000-8000-000000000000/cancel')
        .expect(401);
    });
  });

  // ───────────────────────────────────────────── the transcript path

  describe('device-recognised transcript', () => {
    it('runs the whole turn and keeps no audio at all', async () => {
      const account = await newAccount();
      llm.script(/milk/i, noteOutput('buy milk'));
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk', detectedLanguage: 'en-IN' })
        .expect(201);

      const turn = (res.body as Envelope<TurnView>).data;
      // The note was saved, so the session is finished rather than queued.
      expect(turn.session.state).toBe('COMPLETED');
      expect(turn.assistant!.status).toBe('executed');
      expect(turn.transcript!.text).toBe('note: buy milk');
      // No server-side recogniser ran, so there is nothing to report.
      expect(turn.transcript!.provider.id).toBe('device');
      expect(turn.transcript!.confidence).toBeNull();
      expect(turn.assistant!.intent).toBe('save_note');

      // The web client's path: no audio leaves the device, so no row exists.
      expect(await prisma.audioAsset.count({ where: { voiceSessionId: session.id, kind: 'INPUT' } })).toBe(0);
    });

    it('rejects an empty transcript', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: '   ' })
        .expect(400);
    });

    it('carries Hindi and Hinglish through unmangled', async () => {
      for (const [text, tag] of [
        ['मुझे दूध खरीदने की याद दिलाना', 'hi-IN'],
        ['mujhe milk kharidne ka reminder laga do', 'hi-Latn-IN'],
      ] as const) {
        const account = await newAccount();
        llm.reset();
        llm.script(/.*/, { ...noteOutput(), detectedLanguage: tag });
        const session = await startSession(account.access, { inputMode: 'TEXT' });

        const res = await request(http())
          .post(`/api/v1/voice/sessions/${session.id}/transcript`)
          .set(auth(account.access))
          .send({ text, detectedLanguage: tag })
          .expect(201);

        const turn = (res.body as Envelope<TurnView>).data;
        expect(turn.transcript!.text).toBe(text);
        expect(turn.session.detectedLanguage).toBe(tag);
      }
    });
  });

  // ────────────────────────────────────────────────── the audio path

  describe('audio upload', () => {
    it('transcribes, runs the turn and deletes the recording', async () => {
      const account = await newAccount();
      stt.alwaysReturn('note: buy bread', { detectedLanguage: 'en-IN', confidence: 0.9 });
      llm.script(/bread/i, noteOutput('buy bread'));
      const session = await startSession(account.access);

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', wav({ durationMs: 1_500 }), { filename: 'clip.wav', contentType: 'audio/wav' })
        .expect(201);

      const turn = (res.body as Envelope<TurnView>).data;
      expect(turn.transcript!.text).toBe('note: buy bread');
      // Carried through so nothing can present this as genuinely heard.
      expect(turn.transcript!.provider.isMock).toBe(true);
      expect(turn.session.state).toBe('COMPLETED');

      const asset = await prisma.audioAsset.findFirstOrThrow({
        where: { voiceSessionId: session.id, kind: 'INPUT' },
      });
      // Deleted the moment it had been transcribed, and the row says so
      // rather than pointing at a file that is not there.
      expect(asset.storageKey).toBeNull();
      expect(asset.deletedAt).not.toBeNull();
      // Metadata is kept; the bytes are not.
      expect(asset.byteSize).toBeGreaterThan(0);
      expect(asset.durationMs).toBe(1_500);
      expect(asset.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('leaves nothing on disk once the turn is done', async () => {
      const account = await newAccount();
      stt.alwaysReturn('note: anything');
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', webm(8_192), { filename: 'clip.webm', contentType: 'audio/webm' })
        .expect(201);

      const rows = await prisma.audioAsset.findMany({
        where: { voiceSessionId: session.id },
        select: { storageKey: true, kind: true },
      });
      for (const row of rows) {
        if (row.kind === 'INPUT') expect(row.storageKey).toBeNull();
      }
    });

    it('deletes the recording even when recognition fails', async () => {
      const account = await newAccount();
      stt.failWith(new SttError('unavailable', 'mock', 'service down'));
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', wav({ durationMs: 900 }), { filename: 'c.wav', contentType: 'audio/wav' })
        .expect(503);

      const asset = await prisma.audioAsset.findFirstOrThrow({
        where: { voiceSessionId: session.id, kind: 'INPUT' },
      });
      // A failure is not an excuse to leave bytes behind.
      expect(asset.storageKey).toBeNull();

      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.state).toBe('FAILED');
      expect(row.failureCode).toBe('stt_unavailable');
    });

    it('fails the session when the upload is not audio', async () => {
      const account = await newAccount();
      const session = await startSession(account.access);

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', notAudio(2_048), { filename: 'x.wav', contentType: 'audio/wav' })
        .expect(400);
      expect((res.body as ErrorBody).success).toBe(false);

      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.state).toBe('FAILED');
      expect(row.failureCode).toBe('audio_unsupported_format');
      // Nothing was stored: validation runs before anything is written.
      expect(await prisma.audioAsset.count({ where: { voiceSessionId: session.id } })).toBe(0);
    });

    it('rejects a client that mislabels the format', async () => {
      const account = await newAccount();
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', webm(4_096), { filename: 'lie.wav', contentType: 'audio/wav' })
        .expect(400);

      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.failureCode).toBe('audio_format_mismatch');
    });

    it('rejects an over-long recording', async () => {
      const account = await newAccount();
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', wav({ durationMs: 200_000, sampleRate: 8_000 }), {
          filename: 'long.wav',
          contentType: 'audio/wav',
        })
        .expect(400);

      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(['audio_too_long', 'audio_too_large']).toContain(row.failureCode);
    });

    it('requires a file to be attached', async () => {
      const account = await newAccount();
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .field('languageHint', 'hi-IN')
        .expect(400);
    });

    it('reports nothing heard as its own outcome, not as a failure', async () => {
      const account = await newAccount();
      // The recogniser worked; there was no speech in the recording.
      stt.alwaysReturn('');
      const session = await startSession(account.access);

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', wav({ durationMs: 900 }), { filename: 'q.wav', contentType: 'audio/wav' })
        .expect(201);

      const turn = (res.body as Envelope<TurnView>).data;
      expect(turn.transcript).toBeNull();
      expect(turn.assistant).toBeNull();
      expect(turn.session.failureCode).toBe('no_speech_detected');
      // The assistant was never asked to interpret silence.
      expect(await prisma.assistantCommand.count({ where: { userId: account.userId } })).toBe(0);
    });

    it('keeps the recording when the account asked for retention', async () => {
      const account = await newAccount();
      await enableVoice(account.userId, { audioRetention: 'RETAIN', audioRetentionDays: 3 });
      stt.alwaysReturn('note: keep this');
      llm.script(/.*/, noteOutput('keep this'));
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', wav({ durationMs: 900 }), { filename: 'k.wav', contentType: 'audio/wav' })
        .expect(201);

      const asset = await prisma.audioAsset.findFirstOrThrow({
        where: { voiceSessionId: session.id, kind: 'INPUT' },
      });
      // Retention is opt-in, and this is the only path that keeps audio.
      expect(asset.retention).toBe('RETAIN');
      expect(asset.storageKey).not.toBeNull();
      expect(asset.deleteAfter).not.toBeNull();
      expect(await store.exists(asset.storageKey!)).toBe(true);

      // And the sweep removes it once the window closes.
      await prisma.audioAsset.update({
        where: { id: asset.id },
        data: { deleteAfter: new Date(Date.now() - 1_000) },
      });
      const swept = await voice.applyAudioRetention();
      expect(swept.rows).toBeGreaterThanOrEqual(1);
      expect(await store.exists(asset.storageKey!)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────── speech

  describe('spoken replies', () => {
    it('does not speak unless the account asked', async () => {
      const account = await newAccount();
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);

      const turn = (res.body as Envelope<TurnView>).data;
      expect(turn.speech).toBeNull();
      expect(turn.speechUnavailable).toContain('turned off');
      expect(tts.calls).toHaveLength(0);
    });

    it('speaks the reply and serves it to the owning device', async () => {
      const account = await newAccount();
      await enableVoice(account.userId, { speakReplies: true });
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);

      const turn = (res.body as Envelope<TurnView>).data;
      expect(turn.speech).not.toBeNull();
      expect(turn.speech!.url).toBe(`/api/v1/voice/sessions/${session.id}/speech`);
      // A client can say the reply is not actually being spoken rather than
      // playing silence and looking broken.
      expect(turn.speech!.isMock).toBe(true);

      const audio = await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/speech`)
        .set(auth(account.access))
        .expect(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
      expect(audio.headers['cache-control']).toBe('private, no-store');
      expect((audio.body as Buffer).byteLength).toBeGreaterThan(44);
    });

    it('still returns the text reply when synthesis fails', async () => {
      const account = await newAccount();
      await enableVoice(account.userId, { speakReplies: true });
      llm.script(/.*/, noteOutput());
      const { TtsError } = await import('../src/providers/tts/errors');
      tts.failWith(new TtsError('unavailable', 'mock', 'synth down'));
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);

      const turn = (res.body as Envelope<TurnView>).data;
      // The text reply is the product; speech is an enhancement.
      //
      // And the wording is the executor's, not the model's: the model wrote
      // "Saved it." before anything ran, so it cannot be allowed to
      // describe an outcome it could not know.
      expect(turn.assistant!.reply).toBe('Note saved.');
      expect(turn.session.state).toBe('COMPLETED');
      expect(turn.speech).toBeNull();
      expect(turn.speechUnavailable).toBe('The reply could not be spoken.');
    });

    it('reports no spoken reply as missing rather than serving nothing', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/speech`)
        .set(auth(account.access))
        .expect(404);
    });
  });

  // ───────────────────────────────────────────────── events & reconnect

  describe('events and reconnection', () => {
    it('records the pipeline as a numbered sequence', async () => {
      const account = await newAccount();
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);

      // Events are written asynchronously so a socket write never sits in
      // the path of the response.
      await settle();

      const res = await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/events`)
        .set(auth(account.access))
        .expect(200);

      const { events } = (res.body as Envelope<{ events: { type: string; seq: number }[] }>).data;
      const types = events.map((e) => e.type);
      expect(types).toContain('session.created');
      expect(types).toContain('transcript.final');
      expect(types).toContain('processing.started');
      expect(types).toContain('response.ready');
      // Monotonic from 1, with no gaps, which is what makes "everything
      // after 4" a safe question.
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    });

    it('replays only what a reconnecting client has not seen', async () => {
      const account = await newAccount();
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access, { inputMode: 'TEXT' });
      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);
      await settle();

      const all = await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/events`)
        .set(auth(account.access))
        .expect(200);
      const total = (all.body as Envelope<{ events: unknown[] }>).data.events.length;
      expect(total).toBeGreaterThan(2);

      const after = await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/events?afterSeq=2`)
        .set(auth(account.access))
        .expect(200);
      const resumed = (after.body as Envelope<{ events: { seq: number }[] }>).data.events;

      expect(resumed).toHaveLength(total - 2);
      expect(resumed[0].seq).toBe(3);
    });

    it('never stores a partial transcript', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await voice.pushPartialTranscript(account.userId, account.deviceId, session.id, 'buy mi');
      await voice.pushPartialTranscript(account.userId, account.deviceId, session.id, 'buy milk');
      await settle();

      const stored = await prisma.voiceSessionEvent.findMany({
        where: { voiceSessionId: session.id },
        select: { type: true },
      });
      // An interim guess is not a record of what someone said, and a
      // sequence of half-heard sentences is a worse thing to keep.
      expect(stored.map((e) => e.type)).not.toContain('transcript.partial');
      expect(EPHEMERAL_EVENTS.has('transcript.partial')).toBe(true);
    });

    it('publishes events on the bus with the right audience', async () => {
      const { VoiceEventBus } = await import('../src/modules/voice/voice-event-bus');
      const bus = app.get(VoiceEventBus);
      const seen: { type: string; deviceOnly: boolean }[] = [];
      const off = bus.subscribe((event, target) =>
        seen.push({ type: event.type, deviceOnly: Boolean(target.deviceOnly) }),
      );

      try {
        const account = await newAccount();
        await enableVoice(account.userId, { speakReplies: false });
        llm.script(/.*/, {
          command: { intent: 'send_message', entities: { platform: 'whatsapp', recipient: '+919876543210', message: 'late' } },
          confidence: 0.9,
          clarification: null,
          reply: 'Here it is.',
          detectedLanguage: 'en-IN',
        });
        const session = await startSession(account.access, { inputMode: 'TEXT' });
        await request(http())
          .post(`/api/v1/voice/sessions/${session.id}/transcript`)
          .set(auth(account.access))
          .send({ text: 'whatsapp +919876543210 that I am late' })
          .expect(201);
        await settle();

        // What is being said into this device is that device's business.
        const transcript = seen.find((e) => e.type === 'transcript.final');
        expect(transcript?.deviceOnly).toBe(true);

        // A confirmation is a decision the person makes, and they may be
        // looking at another screen.
        const confirmation = seen.find((e) => e.type === 'confirmation.required');
        expect(confirmation?.deviceOnly).toBe(false);
      } finally {
        off();
      }
    });

    it('survives a listener that throws', async () => {
      const { VoiceEventBus } = await import('../src/modules/voice/voice-event-bus');
      const bus = app.get(VoiceEventBus);
      const off = bus.subscribe(() => {
        throw new Error('a broken socket');
      });

      try {
        const account = await newAccount();
        llm.script(/.*/, noteOutput());
        const session = await startSession(account.access, { inputMode: 'TEXT' });

        // A broken socket is not a reason to lose somebody's answer.
        const res = await request(http())
          .post(`/api/v1/voice/sessions/${session.id}/transcript`)
          .set(auth(account.access))
          .send({ text: 'note: buy milk' })
          .expect(201);
        expect((res.body as Envelope<TurnView>).data.assistant!.reply).toBe('Note saved.');
      } finally {
        off();
      }
    });

    it('publishes the event names it documents, and no others', async () => {
      const account = await newAccount();
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access, { inputMode: 'TEXT' });
      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);
      await settle();

      const stored = await prisma.voiceSessionEvent.findMany({
        where: { voiceSessionId: session.id },
        select: { type: true },
      });
      for (const event of stored) {
        expect(VOICE_EVENTS as readonly string[]).toContain(event.type);
      }
      // There is no event meaning "executed", because nothing executes.
      expect(VOICE_EVENTS as readonly string[]).not.toContain('action.executed');
    });
  });

  // ────────────────────────────────────────────── cancellation & expiry

  describe('cancellation', () => {
    it('cancels, deletes the recording and says nothing was carried out', async () => {
      const account = await newAccount();
      await enableVoice(account.userId, { audioRetention: 'RETAIN', audioRetentionDays: 30 });
      stt.alwaysReturn('note: something');
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/audio`)
        .set(auth(account.access))
        .attach('audio', wav({ durationMs: 900 }), { filename: 'c.wav', contentType: 'audio/wav' })
        .expect(201);

      const kept = await prisma.audioAsset.findFirstOrThrow({
        where: { voiceSessionId: session.id, kind: 'INPUT' },
      });
      expect(kept.storageKey).not.toBeNull();

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/cancel`)
        .set(auth(account.access))
        .expect(200);

      const body = (res.body as Envelope<{
        session: SessionView;
        audioRemoved: number;
        alreadyEnded: boolean;
        note: string;
      }>).data;
      // The note was already saved, so the session had finished. Cancelling
      // does not pretend to undo it — the state stays COMPLETED and
      // `alreadyEnded` says so.
      expect(body.session.state).toBe('COMPLETED');
      expect(body.alreadyEnded).toBe(true);
      // The recording still goes, which is the point of this test.
      expect(body.audioRemoved).toBeGreaterThanOrEqual(1);

      // A user who cancels expects the recording gone, not retained
      // because a setting about completed turns said so.
      const after = await prisma.audioAsset.findUniqueOrThrow({ where: { id: kept.id } });
      expect(after.storageKey).toBeNull();
      expect(await store.exists(kept.storageKey!)).toBe(false);
    });

    it('is idempotent, so a double tap is not an error', async () => {
      const account = await newAccount();
      const session = await startSession(account.access);

      const first = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/cancel`)
        .set(auth(account.access))
        .expect(200);
      expect((first.body as Envelope<{ alreadyEnded: boolean }>).data.alreadyEnded).toBe(false);

      const second = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/cancel`)
        .set(auth(account.access))
        .expect(200);
      expect((second.body as Envelope<{ alreadyEnded: boolean }>).data.alreadyEnded).toBe(true);
    });

    it('refuses further work on a cancelled session', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });
      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/cancel`)
        .set(auth(account.access))
        .expect(200);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'carry on anyway' })
        .expect(409);
    });
  });

  describe('expiry', () => {
    it('expires a session the moment anybody looks at it past its deadline', async () => {
      const account = await newAccount();
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await prisma.voiceSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const res = await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'too late' })
        .expect(409);
      expect((res.body as ErrorBody).message).toContain('expired');

      // Applied on read, not left to a sweep, so a slow client cannot
      // resume something that should be gone.
      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.state).toBe('EXPIRED');
      expect(row.endedAt).not.toBeNull();
    });

    it('sweeps overdue sessions in bulk and leaves live ones alone', async () => {
      const account = await newAccount();
      const overdue = await startSession(account.access, { inputMode: 'TEXT' });
      const live = await startSession(account.access, { inputMode: 'TEXT' });

      await prisma.voiceSession.update({
        where: { id: overdue.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      expect(await sessions.expireOverdue()).toBeGreaterThanOrEqual(1);

      expect((await prisma.voiceSession.findUniqueOrThrow({ where: { id: overdue.id } })).state).toBe('EXPIRED');
      expect((await prisma.voiceSession.findUniqueOrThrow({ where: { id: live.id } })).state).toBe('CREATED');
    });

    it('leaves an already-finished session alone', async () => {
      const account = await newAccount();
      const session = await startSession(account.access);
      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/cancel`)
        .set(auth(account.access))
        .expect(200);

      await prisma.voiceSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await sessions.expireOverdue();

      // Cancelled stays cancelled: the record of what happened matters.
      expect((await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe('CANCELLED');
    });
  });

  // ───────────────────────────────────────────────────────── ownership

  describe('ownership', () => {
    it('hides another account’s session entirely', async () => {
      const owner = await newAccount();
      const stranger = await newAccount();
      const session = await startSession(owner.access, { inputMode: 'TEXT' });

      // 404, not 403: confirming an id exists is itself a disclosure.
      await request(http()).get(`/api/v1/voice/sessions/${session.id}`).set(auth(stranger.access)).expect(404);
      await request(http()).get(`/api/v1/voice/sessions/${session.id}/events`).set(auth(stranger.access)).expect(404);
      await request(http()).get(`/api/v1/voice/sessions/${session.id}/speech`).set(auth(stranger.access)).expect(404);
      await request(http()).post(`/api/v1/voice/sessions/${session.id}/cancel`).set(auth(stranger.access)).expect(404);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(stranger.access))
        .send({ text: 'mine now' })
        .expect(404);
    });

    it('stops one device acting on another device’s voice session', async () => {
      const account = await newAccount();
      const other = await secondDevice(account.email);
      llm.script(/.*/, noteOutput());
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      // Same user, different device. This is the rule the brief asks for.
      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(other.access))
        .send({ text: 'note: buy milk' })
        .expect(404);

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/cancel`)
        .set(auth(other.access))
        .expect(404);

      await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/events`)
        .set(auth(other.access))
        .expect(404);

      // And the session is untouched by the attempts.
      const row = await prisma.voiceSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.state).toBe('CREATED');
      expect(row.deviceId).toBe(account.deviceId);
    });

    it('will not serve one device the spoken reply of another', async () => {
      const account = await newAccount();
      await enableVoice(account.userId, { speakReplies: true });
      llm.script(/.*/, noteOutput());
      const other = await secondDevice(account.email);
      const session = await startSession(account.access, { inputMode: 'TEXT' });

      await request(http())
        .post(`/api/v1/voice/sessions/${session.id}/transcript`)
        .set(auth(account.access))
        .send({ text: 'note: buy milk' })
        .expect(201);

      await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/speech`)
        .set(auth(account.access))
        .expect(200);

      // The URL is not a capability.
      await request(http())
        .get(`/api/v1/voice/sessions/${session.id}/speech`)
        .set(auth(other.access))
        .expect(404);
    });

    it('rejects a malformed session id before touching the database', async () => {
      const account = await newAccount();
      await request(http())
        .get('/api/v1/voice/sessions/not-a-uuid')
        .set(auth(account.access))
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────── capabilities

  describe('capabilities', () => {
    it('describes the formats and providers a client should adapt to', async () => {
      const account = await newAccount();
      const res = await request(http())
        .get('/api/v1/voice/capabilities')
        .set(auth(account.access))
        .expect(200);

      const body = (res.body as Envelope<{
        audio: { formats: { mimeType: string }[]; maxBytes: number; retentionDefault: string };
        stt: { isMock: boolean; capabilities: { mimeTypes: string[] } };
        tts: { isMock: boolean; voices: unknown[] };
        events: string[];
        realtime: { namespace: string; acceptsAudioFrames: boolean };
      }>).data;

      expect(body.audio.formats.map((f) => f.mimeType)).toContain('audio/webm');
      expect(body.audio.maxBytes).toBeGreaterThan(0);
      expect(body.audio.retentionDefault).toBe('DISCARD');
      expect(body.stt.isMock).toBe(true);
      expect(body.events).toEqual([...VOICE_EVENTS]);
      expect(body.realtime.namespace).toBe('/assistant');
      // Stated plainly: continuous audio does not come through the socket.
      expect(body.realtime.acceptsAudioFrames).toBe(false);
    });

    it('exposes no credentials or endpoints', async () => {
      const account = await newAccount();
      const res = await request(http())
        .get('/api/v1/voice/capabilities')
        .set(auth(account.access))
        .expect(200);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/sk-/);
      expect(raw).not.toContain('apiKey');
      expect(raw).not.toContain('api.openai.com');
      expect(raw).not.toContain('googleapis.com');
    });

    it('reports the recogniser as degraded while the stand-in is active', async () => {
      const res = await request(http()).get('/health/ready').expect(200);
      const body = res.body as {
        status: string;
        checks: Record<string, { status: string; degraded?: boolean; detail?: string }>;
      };

      expect(body.status).toBe('ready');
      expect(body.checks.recogniser.status).toBe('up');
      expect(body.checks.recogniser.degraded).toBe(true);
      // Speech synthesis is never required, so it cannot hold readiness down.
      expect(body.checks.synthesiser.status).toBe('not-configured');
    });
  });
});

/** Lets the asynchronous event writes settle before they are asserted on. */
function settle(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
