import { ActionKind, ConnectionProvider, ExecutionMode } from '@prisma/client';
import type { Intent } from './schemas/command.schema';

/**
 * Server-side policy for every intent the assistant accepts.
 *
 * This table — not the model — decides what an intent maps to, whether it
 * needs confirmation, and how far the backend can take it. The model
 * proposes an intent; everything that follows is read from here.
 *
 * Keeping it in one place means the answer to "can the assistant do X
 * without asking?" is a line of data, not behaviour spread across services.
 */
export interface CapabilityPolicy {
  readonly intent: Intent;
  readonly actionKind: ActionKind | null;
  readonly executionMode: ExecutionMode;
  /**
   * Anything that leaves the device or is visible to another person is
   * confirmed, always. Private, local, reversible work is not, because an
   * assistant that asks twice about saving a note is worse than useless.
   */
  readonly requiresConfirmation: boolean;
  /** Entities that must be present and non-null before an action is possible. */
  readonly requiredEntities: readonly string[];
  /**
   * Entities that must be resolved against something real before use.
   * A recipient is the dangerous one: a wrong guess sends a private message
   * to a stranger.
   */
  readonly mustResolve: readonly string[];
  /** Connected account needed, if any. Absent means no account required. */
  readonly requiresConnection: ConnectionProvider | null;
  readonly summary: string;
}

export const CAPABILITIES: Readonly<Record<Intent, CapabilityPolicy>> = {
  save_note: {
    intent: 'save_note',
    actionKind: ActionKind.NOTE_SAVE,
    executionMode: ExecutionMode.LOCAL,
    requiresConfirmation: false,
    requiredEntities: ['text'],
    mustResolve: [],
    requiresConnection: null,
    summary: 'Save a note to this account.',
  },
  retrieve_note: {
    intent: 'retrieve_note',
    actionKind: null,
    executionMode: ExecutionMode.LOCAL,
    requiresConfirmation: false,
    requiredEntities: [],
    mustResolve: [],
    requiresConnection: null,
    summary: 'Read back saved notes.',
  },
  create_reminder: {
    intent: 'create_reminder',
    actionKind: ActionKind.REMINDER_CREATE,
    executionMode: ExecutionMode.LOCAL,
    requiresConfirmation: false,
    // A reminder without a time is not a reminder, so the date is required
    // rather than guessed at.
    requiredEntities: ['text', 'dueAt'],
    mustResolve: ['dueAt'],
    requiresConnection: null,
    summary: 'Create a reminder.',
  },
  send_message: {
    intent: 'send_message',
    actionKind: ActionKind.MESSAGE_WHATSAPP,
    // Nothing here can actually send. The plan is prepared and handed over.
    executionMode: ExecutionMode.ASSISTED,
    requiresConfirmation: true,
    requiredEntities: ['platform', 'message'],
    mustResolve: ['recipient'],
    requiresConnection: null,
    summary: 'Prepare a message for the user to send.',
  },
  prepare_message: {
    intent: 'prepare_message',
    actionKind: ActionKind.MESSAGE_WHATSAPP,
    executionMode: ExecutionMode.ASSISTED,
    requiresConfirmation: true,
    requiredEntities: ['platform', 'message'],
    mustResolve: ['recipient'],
    requiresConnection: null,
    summary: 'Prepare a message draft.',
  },
  open_application: {
    intent: 'open_application',
    actionKind: ActionKind.APP_OPEN,
    executionMode: ExecutionMode.ASSISTED,
    requiresConfirmation: false,
    requiredEntities: ['application'],
    mustResolve: [],
    requiresConnection: null,
    summary: 'Open an application.',
  },
  get_calendar_events: {
    intent: 'get_calendar_events',
    actionKind: ActionKind.CALENDAR_EVENT,
    executionMode: ExecutionMode.ACCOUNT,
    requiresConfirmation: false,
    requiredEntities: [],
    mustResolve: [],
    // Reading an agenda needs an authorised account, which does not exist
    // yet; the orchestrator reports that rather than inventing events.
    requiresConnection: ConnectionProvider.GOOGLE_CALENDAR,
    summary: 'Read calendar events.',
  },
  general_question: {
    intent: 'general_question',
    actionKind: ActionKind.ASSISTANT_REPLY,
    executionMode: ExecutionMode.LOCAL,
    requiresConfirmation: false,
    requiredEntities: ['question'],
    mustResolve: [],
    requiresConnection: null,
    summary: 'Answer a question in conversation.',
  },
};

export function policyFor(intent: Intent): CapabilityPolicy {
  return CAPABILITIES[intent];
}

/** A compact description of what the assistant can do, for the prompt. */
export function capabilitySummary(): string {
  return Object.values(CAPABILITIES)
    .map((c) => `- ${c.intent}: ${c.summary}`)
    .join('\n');
}
