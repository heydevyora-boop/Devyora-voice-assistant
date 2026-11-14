import { Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { AppConfigService } from '../../config/app-config.module';
import { PrincipalService, type ResolvedPrincipal } from '../../security/services/principal.service';
import { VoiceEventBus, type VoiceEventTarget } from './voice-event-bus';
import { VOICE_EVENTS, voiceRoom, type VoiceEvent } from './voice-events';
import { describeSession, VoiceSessionService } from './voice-session.service';
import { VoiceService } from './voice.service';

/** What the socket knows about its own connection. */
interface SocketState {
  readonly principal: ResolvedPrincipal;
  /** When the client last proved it was alive. */
  lastSeenAt: number;
  /**
   * Ids recently delivered to this socket, newest last.
   *
   * The gateway's half of duplicate handling: a reconnecting client is
   * given a replay that may overlap what it already had live, and this
   * stops the same event being written twice onto one connection. The
   * client has the event id too, so it can do the same — belt and braces,
   * because either side alone can be wrong after a reconnect.
   */
  readonly delivered: string[];
}

const states = new WeakMap<Socket, SocketState>();

/** How many ids to remember per socket. A turn produces under a dozen. */
const DEDUPE_WINDOW = 200;

/**
 * How long a socket may go without a heartbeat before it is dropped.
 *
 * socket.io has its own ping/pong at the transport level; this is an
 * application-level check on top, because a socket can be TCP-alive while
 * the client is wedged — and a wedged client holding a room membership
 * means events delivered nowhere.
 */
const HEARTBEAT_TIMEOUT_MS = 90_000;
const HEARTBEAT_SWEEP_MS = 30_000;

/**
 * The real-time transport for voice.
 *
 * One namespace, `/assistant`, with a room per user and a sub-room per
 * device — the arrangement approved in the architecture review, and the
 * reason the pipeline publishes to a bus rather than to sockets directly.
 *
 * Why a socket at all, when the turn is also a REST call: a spoken
 * interaction produces several things at different times — a partial
 * transcript, a settled one, a clarification, a reply — and the orb has to
 * react as each arrives. Polling for that would be worse for latency and
 * for battery, and holding one HTTP response open for the whole turn would
 * make cancellation and reconnection harder, not easier.
 *
 * What this gateway does **not** do: accept a continuous microphone feed.
 * There is no handler here that takes audio frames for wake-word detection,
 * because wake-word detection runs on the device. The transport exists for
 * events and for an authorised utterance after activation.
 *
 * Authentication is the same check as HTTP — `PrincipalService` — applied at
 * connection time. A socket with no valid credential is disconnected before
 * it joins anything, so room membership always implies an authorised
 * identity.
 */
@WebSocketGateway({
  namespace: '/assistant',
  // The allow-list is the one the HTTP layer uses. A socket is not exempt
  // from origin policy just because it is not a fetch.
  cors: { origin: true, credentials: true },
  // Audio is never carried over this channel, so the frame ceiling is small
  // on purpose: a client that tries to stream a recording through it is
  // disconnected rather than quietly accommodated.
  maxHttpBufferSize: 64 * 1024,
})
export class VoiceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(VoiceGateway.name);
  private unsubscribe: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // With a namespace configured on the gateway, what Nest injects here at
  // runtime is the Namespace instance (`io.of('/assistant')`), not the
  // top-level Server — so it is typed as such. Typing it as `Server` is a
  // common mistake that compiles (the two share many members) but resolves
  // `.adapter` to the Server's adapter-constructor setter instead of the
  // Namespace's actual Adapter instance.
  @WebSocketServer()
  private server!: Namespace;

  constructor(
    private readonly principals: PrincipalService,
    private readonly bus: VoiceEventBus,
    private readonly sessions: VoiceSessionService,
    private readonly voice: VoiceService,
    private readonly config: AppConfigService,
  ) {}

  afterInit(): void {
    this.unsubscribe = this.bus.subscribe((event, target) => this.deliver(event, target));

    // Application-level liveness. A socket that stops answering is dropped
    // rather than left holding a room membership that delivers nowhere.
    this.heartbeatTimer = setInterval(() => this.sweepStaleSockets(), HEARTBEAT_SWEEP_MS);
    // Not unref'd: the interval is cleared in onModuleDestroy, and an
    // unref'd timer would let a shutdown race it.

    if (!this.config.providers.redisUrl) {
      // Said once, at startup, because it is a real limitation rather than
      // a detail: with more than one instance, a socket connected to
      // instance A would not receive events published on instance B.
      this.logger.log(
        'Voice events are delivered in-process. A second instance needs the ' +
          'Redis adapter before sockets can span instances.',
      );
    }
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Drops sockets that have stopped answering.
   *
   * Only sockets this gateway authenticated are considered; anything else
   * has already been disconnected.
   */
  private sweepStaleSockets(): void {
    if (!this.server) return;

    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const socket of this.server.sockets.values()) {
      const state = states.get(socket);
      if (!state) continue;
      if (state.lastSeenAt < cutoff) {
        socket.emit('error', { code: 'HEARTBEAT_TIMEOUT' });
        socket.disconnect(true);
      }
    }
  }

  // ───────────────────────────────────────────────────────── connection

  async handleConnection(socket: Socket): Promise<void> {
    const token = extractToken(socket);
    if (!token) {
      // No error detail: an unauthenticated socket is told nothing about
      // why, for the same reason a 401 is uniform.
      socket.emit('error', { code: 'UNAUTHENTICATED' });
      socket.disconnect(true);
      return;
    }

    const principal = await this.principals.fromAccessToken(token);
    if (!principal) {
      socket.emit('error', { code: 'UNAUTHENTICATED' });
      socket.disconnect(true);
      return;
    }

    states.set(socket, { principal, lastSeenAt: Date.now(), delivered: [] });
    await socket.join(voiceRoom.user(principal.userId));
    await socket.join(voiceRoom.device(principal.deviceId));

    this.principals.touchDevice(principal.deviceId);

    socket.emit('connected', {
      userId: principal.userId,
      deviceId: principal.deviceId,
      // Told up front, so a client knows what to expect of this connection.
      interpreter: { events: 'in-process' },
      heartbeat: {
        /** Send `assistant.ping` at least this often to stay connected. */
        intervalMs: HEARTBEAT_SWEEP_MS,
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
      },
      events: VOICE_EVENTS,
    });
  }

  handleDisconnect(socket: Socket): void {
    // Nothing to tear down beyond the map entry: a dropped socket does not
    // cancel a session. The user may be reconnecting, and the turn they
    // started should still be there when they do.
    states.delete(socket);
  }

  // ─────────────────────────────────────────────────────────── messages

  /**
   * Liveness.
   *
   * A client sends this periodically; the reply carries the server's clock
   * so a client can also see its own drift. Any other message counts as
   * liveness too — this exists for an idle connection with nothing to say.
   */
  @SubscribeMessage('assistant.ping')
  ping(@ConnectedSocket() socket: Socket): { ok: boolean; at: string } {
    const state = states.get(socket);
    if (state) state.lastSeenAt = Date.now();
    return { ok: Boolean(state), at: new Date().toISOString() };
  }

  /**
   * Reconnection.
   *
   * A client that dropped mid-turn sends the session id and the last
   * sequence it saw, and is given the session's current state plus every
   * event after that point. Nothing is re-run: the events were recorded as
   * they happened, so a replay is a replay rather than a second pipeline.
   */
  @SubscribeMessage('voice.resume')
  async resume(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean; code?: string; session?: unknown; events?: VoiceEvent[] }> {
    const state = states.get(socket);
    if (!state) return { ok: false, code: 'UNAUTHENTICATED' };
    state.lastSeenAt = Date.now();

    const parsed = parseResume(body);
    if (!parsed) return { ok: false, code: 'BAD_REQUEST' };

    try {
      const { session, events } = await this.sessions.eventsSince(
        state.principal.userId,
        parsed.sessionId,
        parsed.afterSeq,
        // Device-scoped: a session belongs to the device that started it.
        state.principal.deviceId,
      );
      await socket.join(voiceRoom.session(session.id));

      // Remembered, so an event that arrives live a moment later is
      // recognised as one this socket already has.
      for (const event of events) this.remember(state, event.id);

      return { ok: true, session: describeSession(session), events };
    } catch {
      // Another user's or another device's session reads as missing, as it
      // does over HTTP.
      return { ok: false, code: 'NOT_FOUND' };
    }
  }

  /**
   * A partial transcript from a device doing its own recognition.
   *
   * This is text, not audio. It is relayed to the user's other surfaces and
   * never stored.
   */
  @SubscribeMessage('voice.transcript.partial')
  async partial(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean; code?: string }> {
    const state = states.get(socket);
    if (!state) return { ok: false, code: 'UNAUTHENTICATED' };
    state.lastSeenAt = Date.now();

    const parsed = parsePartial(body);
    if (!parsed) return { ok: false, code: 'BAD_REQUEST' };

    try {
      await this.voice.pushPartialTranscript(
        state.principal.userId,
        state.principal.deviceId,
        parsed.sessionId,
        parsed.text,
      );
      return { ok: true };
    } catch {
      return { ok: false, code: 'NOT_FOUND' };
    }
  }

  /** Cancellation from the socket, equivalent to the REST route. */
  @SubscribeMessage('voice.cancel')
  async cancel(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean; code?: string }> {
    const state = states.get(socket);
    if (!state) return { ok: false, code: 'UNAUTHENTICATED' };
    state.lastSeenAt = Date.now();

    const parsed = parseResume(body);
    if (!parsed) return { ok: false, code: 'BAD_REQUEST' };

    try {
      await this.voice.cancel(
        state.principal.userId,
        parsed.sessionId,
        state.principal.deviceId,
        'device',
      );
      return { ok: true };
    } catch {
      return { ok: false, code: 'NOT_FOUND' };
    }
  }

  /**
   * Rejects any attempt to push audio frames down this channel.
   *
   * Explicit rather than absent, so the answer is a stated refusal instead
   * of silence. Continuous microphone audio does not go to the cloud: wake
   * word detection is the device's job, and an utterance after activation
   * is uploaded as a bounded recording where its size and format can be
   * checked.
   */
  @SubscribeMessage('voice.audio.chunk')
  rejectAudio(): { ok: false; code: string; detail: string } {
    return {
      ok: false,
      code: 'UNSUPPORTED',
      detail:
        'Audio is not accepted on this channel. Upload a bounded recording to ' +
        'POST /voice/sessions/:id/audio.',
    };
  }

  // ───────────────────────────────────────────────────────── delivery

  /**
   * Fans an event out to the right room.
   *
   * Device-private events — partial transcripts, listening state — go only
   * to the device that is speaking. A confirmation goes to the whole
   * account, because the person may be looking at another screen; acting on
   * it still requires the owning device.
   */
  private deliver(event: VoiceEvent, target: VoiceEventTarget): void {
    if (!this.server) return;

    const room = target.deviceOnly
      ? voiceRoom.device(target.deviceId)
      : voiceRoom.user(target.userId);

    // Emitted per socket rather than to the room, so a socket that already
    // holds this event — because a replay overlapped a live push — is
    // skipped. Room-level emit cannot do that, and a client drawing the
    // same confirmation twice is the visible symptom.
    // `this.server` is the namespace (`/assistant`), and on a Namespace the
    // adapter lives on the namespace itself — not under `.sockets`, which
    // is just the Map of connected sockets. Getting this wrong throws
    // inside the bus listener, which VoiceEventBus.publish catches and
    // logs, so the failure mode is silent delivery rather than a crash.
    const sockets = this.server.adapter.rooms.get(room);
    if (!sockets) return;

    for (const socketId of sockets) {
      const socket = this.server.sockets.get(socketId);
      if (!socket) continue;

      const state = states.get(socket);
      if (!state) continue;

      if (event.id && state.delivered.includes(event.id)) continue;
      this.remember(state, event.id);

      socket.emit(event.type, event);
    }
  }

  /** Records a delivered id, keeping the window bounded. */
  private remember(state: SocketState, id: string | undefined): void {
    if (!id) return;
    state.delivered.push(id);
    if (state.delivered.length > DEDUPE_WINDOW) {
      state.delivered.splice(0, state.delivered.length - DEDUPE_WINDOW);
    }
  }
}

/** Token from the handshake. Never from a query string, which gets logged. */
function extractToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token.trim()) return auth.token.trim();

  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseResume(body: unknown): { sessionId: string; afterSeq: number } | null {
  if (!body || typeof body !== 'object') return null;
  const { sessionId, afterSeq } = body as { sessionId?: unknown; afterSeq?: unknown };
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;

  const seq = typeof afterSeq === 'number' && Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
  return { sessionId, afterSeq: seq };
}

function parsePartial(body: unknown): { sessionId: string; text: string } | null {
  if (!body || typeof body !== 'object') return null;
  const { sessionId, text } = body as { sessionId?: unknown; text?: unknown };
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
  if (typeof text !== 'string') return null;
  return { sessionId, text: text.slice(0, 2_000) };
}
