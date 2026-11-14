import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  VoiceSessionState as State,
  type Prisma,
  type VoiceInputMode,
  type VoiceSession,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { requestContext } from '../../common/request-context';
import { AppConfigService } from '../../config/app-config.module';
import { EPHEMERAL_EVENTS, type VoiceEvent, type VoiceEventPayload } from './voice-events';

/**
 * The permitted transitions.
 *
 * Written as data rather than as `if` statements scattered through the
 * pipeline, so the whole machine can be read — and tested — in one place.
 * A transition that is not listed cannot happen: `transitionTo` refuses it
 * and the session stays where it was.
 *
 * Note what every live state can reach: `CANCELLED`, `FAILED` and
 * `EXPIRED`. A user must always be able to stop a voice interaction, and a
 * session must never be able to get wedged somewhere with no way out.
 */
const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  [State.CREATED]: [State.LISTENING, State.TRANSCRIBING, State.INTERPRETING, State.CANCELLED, State.EXPIRED, State.FAILED],
  [State.LISTENING]: [State.TRANSCRIBING, State.INTERPRETING, State.CANCELLED, State.EXPIRED, State.FAILED],
  [State.TRANSCRIBING]: [State.INTERPRETING, State.CANCELLED, State.EXPIRED, State.FAILED],
  [State.INTERPRETING]: [
    State.AWAITING_CLARIFICATION,
    State.AWAITING_CONFIRMATION,
    State.QUEUED,
    State.COMPLETED,
    State.CANCELLED,
    State.EXPIRED,
    State.FAILED,
  ],
  // A clarification is answered by a new turn on the same session, which
  // starts the pipeline again.
  [State.AWAITING_CLARIFICATION]: [State.TRANSCRIBING, State.INTERPRETING, State.CANCELLED, State.EXPIRED, State.FAILED],
  [State.AWAITING_CONFIRMATION]: [State.QUEUED, State.CANCELLED, State.EXPIRED, State.FAILED],
  // QUEUED is where this build stops. The executor that moves it onward
  // arrives with the action workers; until then COMPLETED is reached only
  // for turns that needed no action.
  [State.QUEUED]: [State.COMPLETED, State.CANCELLED, State.EXPIRED, State.FAILED],

  // Terminal.
  [State.COMPLETED]: [],
  [State.CANCELLED]: [],
  [State.EXPIRED]: [],
  [State.FAILED]: [],
};

/** States from which nothing further happens. */
export const TERMINAL_STATES: readonly State[] = [
  State.COMPLETED,
  State.CANCELLED,
  State.EXPIRED,
  State.FAILED,
];

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CreateVoiceSessionInput {
  readonly userId: string;
  readonly deviceId: string;
  readonly inputMode: VoiceInputMode;
  readonly wakeWordTriggered?: boolean;
  readonly languageHint?: string | null;
  readonly conversationId?: string | null;
}

/**
 * Voice session state, ownership and the event log.
 *
 * Every read is scoped by both user and device where device scoping is
 * meaningful, and the ownership check is one method that everything else
 * goes through — so there is no route that reaches a session by id alone.
 */
@Injectable()
export class VoiceSessionService {
  private readonly logger = new Logger(VoiceSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async create(input: CreateVoiceSessionInput): Promise<VoiceSession> {
    const ttl = this.config.providers.voice.sessionTtlMs;

    return this.prisma.voiceSession.create({
      data: {
        userId: input.userId,
        deviceId: input.deviceId,
        inputMode: input.inputMode,
        wakeWordTriggered: input.wakeWordTriggered ?? false,
        languageHint: input.languageHint?.slice(0, 24),
        conversationId: input.conversationId ?? undefined,
        state: State.CREATED,
        expiresAt: new Date(Date.now() + ttl),
      },
    });
  }

  /**
   * Finds a session the caller owns.
   *
   * `requireDevice` is the rule the brief asks for: one device must not act
   * on another device's pending voice action. It is enforced here rather
   * than in a controller, so it cannot be forgotten on a new route.
   *
   * A session belonging to another user — or to another device when device
   * scoping applies — is reported as missing, not forbidden, for the same
   * reason as everywhere else in this codebase: confirming that an id
   * exists is itself a disclosure.
   */
  async requireOwned(
    userId: string,
    sessionId: string,
    options: { requireDevice?: string | null } = {},
  ): Promise<VoiceSession> {
    const session = await this.prisma.voiceSession.findFirst({
      where: {
        id: sessionId,
        userId,
        ...(options.requireDevice ? { deviceId: options.requireDevice } : {}),
      },
    });
    if (!session) throw AppError.notFound('Voice session');
    return session;
  }

  /**
   * Fetches a session for work, refusing one that has run out of time.
   *
   * The expiry is applied on read rather than waiting for a sweep: a
   * session that is past its deadline is expired the moment anybody looks
   * at it, so a slow client cannot resume something that should be gone.
   */
  async requireActive(
    userId: string,
    sessionId: string,
    options: { requireDevice?: string | null } = {},
  ): Promise<VoiceSession> {
    const session = await this.requireOwned(userId, sessionId, options);

    if (isTerminal(session.state)) {
      throw AppError.conflict(`That voice session is already ${session.state.toLowerCase()}.`);
    }
    if (session.expiresAt <= new Date()) {
      await this.expire(session.id);
      throw AppError.conflict('That voice session expired. Start a new one.');
    }
    return session;
  }

  /**
   * Moves a session, or refuses.
   *
   * The update is conditional on the state we believe it is in, so two
   * concurrent requests cannot both think they made the transition. The
   * loser gets a conflict rather than silently overwriting.
   */
  async transitionTo(
    sessionId: string,
    from: State,
    to: State,
    data: Prisma.VoiceSessionUpdateInput = {},
  ): Promise<VoiceSession> {
    if (!canTransition(from, to)) {
      throw AppError.conflict(`A voice session cannot move from ${from} to ${to}.`);
    }

    const { count } = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, state: from },
      data: {
        state: to,
        ...(isTerminal(to) ? { endedAt: new Date() } : {}),
        ...data,
      },
    });

    if (count === 0) {
      // Either it moved underneath us or it never was in `from`.
      throw AppError.conflict('That voice session changed while it was being updated.');
    }

    return this.prisma.voiceSession.findUniqueOrThrow({ where: { id: sessionId } });
  }

  /**
   * Cancellation.
   *
   * Idempotent on purpose: a user who taps cancel twice, or a client that
   * retries after a dropped connection, should get the same answer rather
   * than a conflict. Cancelling something already finished is a no-op, and
   * says so.
   */
  async cancel(
    userId: string,
    sessionId: string,
    deviceId: string | null,
  ): Promise<{ session: VoiceSession; alreadyEnded: boolean }> {
    const session = await this.requireOwned(userId, sessionId, { requireDevice: deviceId });

    if (isTerminal(session.state)) {
      return { session, alreadyEnded: true };
    }

    const cancelled = await this.transitionTo(session.id, session.state, State.CANCELLED);
    return { session: cancelled, alreadyEnded: false };
  }

  /** Marks a session expired, wherever it had got to. */
  async expire(sessionId: string): Promise<void> {
    await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, state: { notIn: [...TERMINAL_STATES] } },
      data: { state: State.EXPIRED, endedAt: new Date() },
    });
  }

  /**
   * Expires everything past its deadline.
   *
   * Called by the retention job once the background workers exist. Written
   * here because expiry is a property of a voice session, not of whatever
   * scheduler happens to trigger it.
   */
  async expireOverdue(now = new Date()): Promise<number> {
    const { count } = await this.prisma.voiceSession.updateMany({
      where: { expiresAt: { lte: now }, state: { notIn: [...TERMINAL_STATES] } },
      data: { state: State.EXPIRED, endedAt: now },
    });
    if (count > 0) this.logger.log(`Expired ${count} overdue voice session(s).`);
    return count;
  }

  /**
   * Records an event and returns it with its sequence number assigned.
   *
   * The sequence is allocated by incrementing a counter on the session row
   * in the same transaction as the insert, so two events cannot be given
   * the same number. That is what makes "give me everything after 4" a
   * safe question for a reconnecting client.
   *
   * Ephemeral events — partial transcripts — are given sequence 0 and are
   * not written. They are pushed live and then gone.
   */
  async recordEvent<T extends VoiceEvent>(
    session: { id: string; userId: string; deviceId: string },
    type: T['type'],
    payload: VoiceEventPayload<T>,
  ): Promise<T> {
    const at = new Date();
    // A fresh id per event. This is what lets a reconnecting client discard
    // something it already holds without comparing contents.
    const id = randomUUID();
    const correlationId = requestContext.correlationId() ?? null;

    const envelope = {
      id,
      userId: session.userId,
      deviceId: session.deviceId,
      sessionId: session.id,
      at: at.toISOString(),
      correlationId,
    };

    if (EPHEMERAL_EVENTS.has(type)) {
      return { ...payload, ...envelope, type, seq: 0 } as unknown as T;
    }

    const seq = await this.prisma.transaction(async (tx) => {
      const row = await tx.voiceSession.update({
        where: { id: session.id },
        data: { lastEventSeq: { increment: 1 } },
        select: { lastEventSeq: true },
      });

      await tx.voiceSessionEvent.create({
        data: {
          voiceSessionId: session.id,
          seq: row.lastEventSeq,
          type,
          // The envelope is reconstructed on replay from the row and the
          // session, so only the event-specific fields are stored. Keeping
          // a second copy of the ids would be a second thing to disagree.
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });

      return row.lastEventSeq;
    });

    return { ...payload, ...envelope, type, seq } as unknown as T;
  }

  /**
   * Replays a session's events for a client that reconnected.
   *
   * Ownership is checked first, so a leaked session id does not replay
   * someone else's interaction.
   */
  async eventsSince(
    userId: string,
    sessionId: string,
    afterSeq: number,
    deviceId: string | null,
  ): Promise<{ session: VoiceSession; events: VoiceEvent[] }> {
    const session = await this.requireOwned(userId, sessionId, { requireDevice: deviceId });

    const rows = await this.prisma.voiceSessionEvent.findMany({
      where: { voiceSessionId: sessionId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      // A session cannot produce an unbounded number of events, but a
      // bound here means a corrupt row count cannot become a huge response.
      take: 200,
    });

    return {
      session,
      events: rows.map(
        (row) =>
          ({
            ...(row.payload as object),
            // The same id every time this row is replayed, so a client
            // that receives it twice recognises it as one event.
            id: row.id,
            userId: session.userId,
            deviceId: session.deviceId,
            sessionId,
            type: row.type,
            seq: row.seq,
            at: row.createdAt.toISOString(),
            correlationId: null,
          }) as VoiceEvent,
      ),
    };
  }

  /** A session's current shape, for a client asking where things stand. */
  async snapshot(userId: string, sessionId: string, deviceId: string | null) {
    const session = await this.requireOwned(userId, sessionId, { requireDevice: deviceId });
    return describeSession(session);
  }
}

/**
 * What a client is told about a session.
 *
 * Built explicitly rather than returning the row, so a column added later
 * is not exposed by accident.
 */
export function describeSession(session: VoiceSession) {
  return {
    id: session.id,
    state: session.state,
    inputMode: session.inputMode,
    wakeWordTriggered: session.wakeWordTriggered,
    transcript: session.transcript,
    detectedLanguage: session.detectedLanguage,
    conversationId: session.conversationId,
    commandId: session.commandId,
    pendingActionId: session.pendingActionId,
    replyText: session.replyText,
    failureCode: session.failureCode,
    lastEventSeq: session.lastEventSeq,
    expiresAt: session.expiresAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
  };
}
