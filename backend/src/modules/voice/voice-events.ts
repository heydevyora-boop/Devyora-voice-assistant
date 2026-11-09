import type { VoiceSessionState } from '@prisma/client';

/**
 * The wire contract for voice events.
 *
 * These are what the orb reacts to. They are defined here, once, and used
 * by both the socket gateway and the stored event log, so a client that
 * reconnects and replays history sees exactly the shapes it would have
 * received live.
 *
 * Two deliberate properties:
 *
 * `transcript.partial` is never stored. An interim guess is not a record of
 * what someone said, and keeping a sequence of half-heard sentences would
 * be a worse privacy position than keeping the final one.
 *
 * There is no `action.executed` event. Nothing in this build executes, and
 * an event name is a promise to a client — adding one before there is an
 * executor would have clients drawing a tick that means nothing.
 */
export const VOICE_EVENTS = [
  'session.created',
  'listening.started',
  'transcript.partial',
  'transcript.final',
  'processing.started',
  'clarification.required',
  'confirmation.required',
  'response.ready',
  'session.cancelled',
  'session.expired',
  'session.failed',
] as const;

export type VoiceEventType = (typeof VOICE_EVENTS)[number];

/** Events that are pushed live and never written to the log. */
export const EPHEMERAL_EVENTS: ReadonlySet<VoiceEventType> = new Set<VoiceEventType>([
  'transcript.partial',
]);

interface BaseEvent {
  readonly sessionId: string;
  /**
   * Monotonic within a session, starting at 1. A reconnecting client sends
   * the last sequence it saw and is given everything after it.
   * Zero for ephemeral events, which are not part of the sequence.
   */
  readonly seq: number;
  readonly at: string;
}

export interface SessionCreatedEvent extends BaseEvent {
  readonly type: 'session.created';
  readonly state: VoiceSessionState;
  readonly inputMode: 'TEXT' | 'UPLOAD' | 'STREAM';
  readonly expiresAt: string;
}

export interface ListeningStartedEvent extends BaseEvent {
  readonly type: 'listening.started';
  readonly state: VoiceSessionState;
}

/** Pushed while the user is still speaking. Not stored. */
export interface TranscriptPartialEvent extends BaseEvent {
  readonly type: 'transcript.partial';
  readonly text: string;
  /** True when a stand-in produced this, so no client can present it as heard. */
  readonly isMock: boolean;
}

export interface TranscriptFinalEvent extends BaseEvent {
  readonly type: 'transcript.final';
  readonly text: string;
  readonly detectedLanguage: string | null;
  readonly confidence: number | null;
  readonly durationMs: number | null;
  readonly provider: { readonly id: string; readonly isMock: boolean };
}

export interface ProcessingStartedEvent extends BaseEvent {
  readonly type: 'processing.started';
  readonly state: VoiceSessionState;
}

export interface ClarificationRequiredEvent extends BaseEvent {
  readonly type: 'clarification.required';
  readonly question: string;
  readonly reason: string;
  readonly field: string;
  readonly options: readonly { readonly label: string; readonly value: string | null }[];
  /** Echo on the follow-up turn so the request is resumed, not restarted. */
  readonly commandId: string;
}

export interface ConfirmationRequiredEvent extends BaseEvent {
  readonly type: 'confirmation.required';
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
  readonly type: 'response.ready';
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
  readonly type: 'session.cancelled';
  readonly by: 'user' | 'device' | 'system';
}

export interface SessionExpiredEvent extends BaseEvent {
  readonly type: 'session.expired';
}

export interface SessionFailedEvent extends BaseEvent {
  readonly type: 'session.failed';
  /** A normalised code, e.g. `stt_timeout`. Never a provider message. */
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
  | ResponseReadyEvent
  | SessionCancelledEvent
  | SessionExpiredEvent
  | SessionFailedEvent;

/** Event payloads as stored and replayed: everything but the envelope. */
export type VoiceEventPayload<T extends VoiceEvent = VoiceEvent> = Omit<
  T,
  'sessionId' | 'seq' | 'at' | 'type'
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
