import type { VoiceSessionState } from '@prisma/client';

/**
 * The wire contract for assistant events.
 *
 * Defined once and used by both the socket gateway and the stored event
 * log, so a client that reconnects and replays history sees exactly the
 * shapes it would have received live.
 *
 * ## The envelope
 *
 * Every event carries an `id`, a `type`, a timestamp, the owning `userId`,
 * the `deviceId` and `sessionId` it belongs to, and a sequence number. The
 * `id` is what makes duplicate handling possible on the client: a
 * reconnecting device may be sent an event it already has, and comparing
 * ids is cheaper and surer than comparing contents.
 *
 * ## Names
 *
 * Prefixed `assistant.`, which is the published contract. An earlier
 * iteration used bare names (`session.created`); they were renamed when the
 * gateway stopped being voice-only, because these events now describe
 * action execution as well as speech.
 *
 * ## Two deliberate properties
 *
 * `assistant.transcript.partial` is never stored. An interim guess is not a
 * record of what someone said, and keeping a sequence of half-heard
 * sentences would be a worse privacy position than keeping the final one.
 *
 * The three `assistant.action.*` events exist now that something actually
 * executes. They did not exist while nothing did — an event name is a
 * promise to a client, and one that meant nothing would have had clients
 * drawing a tick for work that had not happened.
 */
export const VOICE_EVENTS = [
  'assistant.session.created',
  'assistant.listening',
  'assistant.transcript.partial',
  'assistant.transcript.final',
  'assistant.processing',
  'assistant.clarification.required',
  'assistant.confirmation.required',
  'assistant.action.started',
  'assistant.action.completed',
  'assistant.action.failed',
  'assistant.response.ready',
  'assistant.session.cancelled',
  'assistant.session.expired',
  'assistant.session.failed',
] as const;

export type VoiceEventType = (typeof VOICE_EVENTS)[number];

/** Events that are pushed live and never written to the log. */
export const EPHEMERAL_EVENTS: ReadonlySet<VoiceEventType> = new Set<VoiceEventType>([
  'assistant.transcript.partial',
]);

interface BaseEvent {
  /**
   * Unique per event. A reconnecting client uses it to discard something it
   * already has, which is both cheaper and surer than comparing contents.
   */
  readonly id: string;
  /** The owning account. Delivered only into that account's room. */
  readonly userId: string;
  /** The device the session belongs to. */
  readonly deviceId: string;
  readonly sessionId: string;
  /**
   * Monotonic within a session, starting at 1. A reconnecting client sends
   * the last sequence it saw and is given everything after it.
   * Zero for ephemeral events, which are not part of the sequence.
   */
  readonly seq: number;
  readonly at: string;
  /** Ties an event back to the request that caused it, for tracing. */
  readonly correlationId: string | null;
}

export interface SessionCreatedEvent extends BaseEvent {
  readonly type: 'assistant.session.created';
  readonly state: VoiceSessionState;
  readonly inputMode: 'TEXT' | 'UPLOAD' | 'STREAM';
  readonly expiresAt: string;
}

export interface ListeningStartedEvent extends BaseEvent {
  readonly type: 'assistant.listening';
  readonly state: VoiceSessionState;
}

/** Pushed while the user is still speaking. Not stored. */
export interface TranscriptPartialEvent extends BaseEvent {
  readonly type: 'assistant.transcript.partial';
  readonly text: string;
  /** True when a stand-in produced this, so no client can present it as heard. */
  readonly isMock: boolean;
}

export interface TranscriptFinalEvent extends BaseEvent {
  readonly type: 'assistant.transcript.final';
  readonly text: string;
  readonly detectedLanguage: string | null;
  readonly confidence: number | null;
  readonly durationMs: number | null;
  readonly provider: { readonly id: string; readonly isMock: boolean };
}

export interface ProcessingStartedEvent extends BaseEvent {
  readonly type: 'assistant.processing';
  readonly state: VoiceSessionState;
}

export interface ClarificationRequiredEvent extends BaseEvent {
  readonly type: 'assistant.clarification.required';
  readonly question: string;
  readonly reason: string;
  readonly field: string;
  readonly options: readonly { readonly label: string; readonly value: string | null }[];
  /** Echo on the follow-up turn so the request is resumed, not restarted. */
  readonly commandId: string;
}

export interface ConfirmationRequiredEvent extends BaseEvent {
  readonly type: 'assistant.confirmation.required';
  readonly pendingActionId: string;
  readonly kind: string;
  readonly intent: string;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly editable: boolean;
    readonly multiline?: boolean;
  }[];
  readonly expiresAt: string;
}

export interface ResponseReadyEvent extends BaseEvent {
  readonly type: 'assistant.response.ready';
  readonly text: string;
  readonly intent: string | null;
  /**
   * The assistant's own status vocabulary, passed through unchanged. It
   * contains no value meaning "executed", because nothing executes yet.
   */
  readonly status: string;
  /** Present when a spoken version is available to fetch. */
  readonly speech: {
    readonly url: string;
    readonly mimeType: string;
    readonly durationMs: number | null;
    readonly voice: string;
    readonly isMock: boolean;
  } | null;
  /**
   * Why speech is absent, when it is. A client shows text either way; this
   * exists so a user who expected a spoken reply can be told why there
   * isn't one instead of being left guessing.
   */
  readonly speechUnavailable: string | null;
}

export interface SessionCancelledEvent extends BaseEvent {
  readonly type: 'assistant.session.cancelled';
  readonly by: 'user' | 'device' | 'system';
}

export interface SessionExpiredEvent extends BaseEvent {
  readonly type: 'assistant.session.expired';
}

export interface SessionFailedEvent extends BaseEvent {
  readonly type: 'assistant.session.failed';
  /** A normalised code, e.g. `stt_timeout`. Never a provider message. */
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/**
 * An action has been claimed and is running.
 *
 * Emitted by the executor, so a client can show work in progress rather
 * than a frozen orb while a provider is being called.
 */
export interface ActionStartedEvent extends BaseEvent {
  readonly type: 'assistant.action.started';
  readonly pendingActionId: string;
  readonly actionId: string;
  readonly executionId: string;
}

export interface ActionCompletedEvent extends BaseEvent {
  readonly type: 'assistant.action.completed';
  readonly pendingActionId: string;
  readonly actionId: string;
  readonly executionId: string;
  /**
   * The executor's own status, unchanged: COMPLETED, HANDOFF, PARTIAL or
   * UNVERIFIED. A client must not read any of the last three as success.
   */
  readonly status: string;
  /** True only when the effect was read back. */
  readonly verified: boolean;
  readonly detail: string;
}

export interface ActionFailedEvent extends BaseEvent {
  readonly type: 'assistant.action.failed';
  readonly pendingActionId: string;
  readonly actionId: string;
  readonly executionId: string | null;
  /** A normalised code. Never a provider message. */
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;
}

export type VoiceEvent =
  | SessionCreatedEvent
  | ListeningStartedEvent
  | TranscriptPartialEvent
  | TranscriptFinalEvent
  | ProcessingStartedEvent
  | ClarificationRequiredEvent
  | ConfirmationRequiredEvent
  | ActionStartedEvent
  | ActionCompletedEvent
  | ActionFailedEvent
  | ResponseReadyEvent
  | SessionCancelledEvent
  | SessionExpiredEvent
  | SessionFailedEvent;

/** Event payloads as stored and replayed: everything but the envelope. */
export type VoiceEventPayload<T extends VoiceEvent = VoiceEvent> = Omit<
  T,
  'id' | 'userId' | 'deviceId' | 'sessionId' | 'seq' | 'at' | 'type' | 'correlationId'
>;

/** The rooms an event is delivered to. */
export const voiceRoom = {
  /** Every device signed in as this user. */
  user: (userId: string) => `user:${userId}`,
  /** One device, for events that are only that device's business. */
  device: (deviceId: string) => `device:${deviceId}`,
  /** One session, which a client joins for the duration of a turn. */
  session: (sessionId: string) => `voice:${sessionId}`,
};
