import { ActionKind, ConnectionProvider, ExecutionMode } from '@prisma/client';
import { findAction } from '../actions/registry/action.registry';
import type { Intent } from './schemas/command.schema';

/**
 * Server-side policy for every intent the assistant accepts.
 *
 * This table — not the model — decides what an intent maps to and how far
 * the backend can take it. The model proposes an intent; everything that
 * follows is read from here.
 *
 * One deliberate division of labour. This table owns what is *about the
 * intent*: which entities the model must extract, and which of them have to
 * resolve to something real. The **action registry** owns what is about the
 * work itself — whether confirmation is required, which permissions apply,
 * which connected account is needed. `requiresConfirmation` below is read
 * from the registry rather than written here, because a confirmation rule
 * that exists in two places is a confirmation rule that will eventually
 * differ in one of them, and this is the single worst place for that to
 * happen.
 */
export interface CapabilityPolicy {
  readonly intent: Intent;
  /**
   * The registry action this intent runs, or null when the intent is
   * answered in conversation. An intent cannot name anything that is not in
   * the registry — `assertCapabilitiesResolve` fails at load if it does.
   */
  readonly actionId: string | null;
  readonly actionKind: ActionKind | null;
  readonly executionMode: ExecutionMode;
  /**
   * Whether the user must approve first. **Derived from the registry**, not
   * declared here. Anything that leaves the device or is visible to another
   * person is confirmed, always; private, local, reversible work is not.
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

/** What this table declares itself: everything about the *intent*. */
interface IntentPolicy {
  /** The registry action, or null when the intent is answered in conversation. */
  readonly actionId: string | null;
  readonly requiredEntities: readonly string[];
  readonly mustResolve: readonly string[];
  readonly summary: string;
  /** Used only for intents with no action, where nothing can be derived. */
  readonly fallback?: {
    readonly actionKind: ActionKind | null;
    readonly executionMode: ExecutionMode;
  };
}

const INTENT_POLICIES: Readonly<Record<Intent, IntentPolicy>> = {
  save_note: {
    actionId: 'notes.create',
    requiredEntities: ['text'],
    mustResolve: [],
    summary: 'Save a note to this account.',
  },
  retrieve_note: {
    actionId: 'notes.search',
    requiredEntities: [],
    mustResolve: [],
    summary: 'Read back saved notes.',
  },
  create_reminder: {
    actionId: 'reminders.create',
    // A reminder without a time is not a reminder, so the date is required
    // rather than guessed at.
    requiredEntities: ['text', 'dueAt'],
    mustResolve: ['dueAt'],
    summary: 'Create a reminder.',
  },
  send_message: {
    actionId: 'messaging.prepare',
    requiredEntities: ['platform', 'message'],
    mustResolve: ['recipient'],
    summary: 'Prepare a message for the user to send.',
  },
  prepare_message: {
    actionId: 'messaging.prepare',
    requiredEntities: ['platform', 'message'],
    mustResolve: ['recipient'],
    summary: 'Prepare a message draft.',
  },
  open_application: {
    actionId: 'apps.launch',
    requiredEntities: ['application'],
    mustResolve: [],
    summary: 'Open an application.',
  },
  get_calendar_events: {
    actionId: 'calendar.list',
    requiredEntities: [],
    mustResolve: [],
    summary: 'Read calendar events.',
  },
  general_question: {
    // Answered in conversation. No action runs, so there is no registry
    // entry to derive policy from.
    actionId: null,
    requiredEntities: ['question'],
    mustResolve: [],
    summary: 'Answer a question in conversation.',
    fallback: { actionKind: ActionKind.ASSISTANT_REPLY, executionMode: ExecutionMode.LOCAL },
  },
};

/**
 * The full policy per intent, with the action half read from the registry.
 *
 * Built once at module load. If an intent names an action that is not in
 * the registry, this throws and the process does not start — which is the
 * behaviour you want, because the alternative is an intent that reaches the
 * executor and fails there instead.
 */
export const CAPABILITIES: Readonly<Record<Intent, CapabilityPolicy>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(INTENT_POLICIES) as [Intent, IntentPolicy][]).map(([intent, policy]) => {
      if (!policy.actionId) {
        return [
          intent,
          {
            intent,
            actionId: null,
            actionKind: policy.fallback?.actionKind ?? null,
            executionMode: policy.fallback?.executionMode ?? ExecutionMode.LOCAL,
            requiresConfirmation: false,
            requiredEntities: policy.requiredEntities,
            mustResolve: policy.mustResolve,
            requiresConnection: null,
            summary: policy.summary,
          } satisfies CapabilityPolicy,
        ];
      }

      const action = findAction(policy.actionId);
      if (!action) {
        throw new Error(
          `Intent "${intent}" names action "${policy.actionId}", which is not in the registry.`,
        );
      }

      return [
        intent,
        {
          intent,
          actionId: action.id,
          actionKind: action.kind,
          executionMode: action.executionMode,
          // The single source. Not restated here.
          requiresConfirmation: action.confirmationPolicy === 'always',
          requiredEntities: policy.requiredEntities,
          mustResolve: policy.mustResolve,
          requiresConnection: (action.requiresConnection as ConnectionProvider | null) ?? null,
          summary: policy.summary,
        } satisfies CapabilityPolicy,
      ];
    }),
  ),
) as Readonly<Record<Intent, CapabilityPolicy>>;

export function policyFor(intent: Intent): CapabilityPolicy {
  return CAPABILITIES[intent];
}

/** A compact description of what the assistant can do, for the prompt. */
export function capabilitySummary(): string {
  return Object.values(CAPABILITIES)
    .map((c) => `- ${c.intent}: ${c.summary}`)
    .join('\n');
}
