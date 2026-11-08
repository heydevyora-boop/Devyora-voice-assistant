import type { OrbState } from './types';

/**
 * Orb transition table.
 *
 * Events are split into two groups on purpose:
 *
 *  - USER events come from the interface (tapping the orb, approving an
 *    action, retrying).
 *  - PIPELINE events come from the voice/AI layer that Chunk 4 introduces.
 *
 * Nothing in this chunk emits a pipeline event. The orb therefore never
 * invents progress: it moves to `listening` when the user activates it and
 * stays there until the user stops it or a real pipeline reports a result.
 */
export type OrbEvent =
  // user-driven
  | { type: 'ACTIVATE' }
  | { type: 'CANCEL' }
  | { type: 'APPROVE' }
  | { type: 'REJECT' }
  | { type: 'REVISE' }
  | { type: 'RETRY' }
  | { type: 'DISMISS' }
  // pipeline-driven (Chunk 4+)
  | { type: 'SPEECH_CAPTURED' }
  | { type: 'NEEDS_APPROVAL' }
  | { type: 'RUN' }
  | { type: 'COMPLETED' }
  | { type: 'FAILED'; reason?: string };

type TransitionMap = Partial<Record<OrbEvent['type'], OrbState>>;

const TRANSITIONS: Readonly<Record<OrbState, TransitionMap>> = {
  idle: {
    ACTIVATE: 'listening',
  },
  listening: {
    ACTIVATE: 'idle', // second tap stops listening
    CANCEL: 'idle',
    SPEECH_CAPTURED: 'processing',
    FAILED: 'error',
  },
  processing: {
    // deliberately not interruptible by ACTIVATE — see `locked` in orbStates
    CANCEL: 'idle',
    NEEDS_APPROVAL: 'confirmation',
    RUN: 'executing',
    COMPLETED: 'success',
    FAILED: 'error',
  },
  confirmation: {
    APPROVE: 'executing',
    REJECT: 'idle',
    REVISE: 'listening',
    CANCEL: 'idle',
    ACTIVATE: 'idle',
    FAILED: 'error',
  },
  executing: {
    CANCEL: 'idle',
    COMPLETED: 'success',
    FAILED: 'error',
  },
  success: {
    ACTIVATE: 'listening',
    DISMISS: 'idle',
    CANCEL: 'idle',
  },
  error: {
    RETRY: 'listening',
    ACTIVATE: 'listening',
    DISMISS: 'idle',
    CANCEL: 'idle',
  },
};

/**
 * Resolve a transition. Returns `null` when the event is not legal in the
 * current state, which callers treat as "ignore" rather than "throw" — an
 * out-of-order event from an interrupted interaction must never crash the UI.
 */
export function transition(state: OrbState, event: OrbEvent): OrbState | null {
  const next = TRANSITIONS[state][event.type];
  if (!next || next === state) return null;
  return next;
}

export function canHandle(state: OrbState, eventType: OrbEvent['type']): boolean {
  return TRANSITIONS[state][eventType] !== undefined;
}

/** States that resolve on their own after being shown. */
export const AUTO_DISMISS_MS: Partial<Record<OrbState, number>> = {
  success: 2400,
};
