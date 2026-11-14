import type {
  ActionKind,
  ConnectionProvider,
  ExecutionMode,
  ExecutionStatus,
} from '@prisma/client';
import type { PrismaService } from '../../../database/prisma.service';
import type { z } from 'zod';

/**
 * A permission the server requires before an action may run.
 *
 * These are checked against state the server owns — account status, device
 * records, connected accounts, the user's own preferences. None of them is
 * ever asserted by a client or inferred from model output.
 */
export type Permission =
  /** Any authenticated account in good standing. */
  | 'account.active'
  /** A device that is registered and not revoked. */
  | 'device.active'
  /** The user has not turned off assistant actions entirely. */
  | 'assistant.enabled'
  /** Private data this account owns: notes, reminders. */
  | 'data.write'
  | 'data.read'
  /** Hands something to another application on the device. */
  | 'handoff.launch'
  /** Prepares something a person will see. */
  | 'messaging.prepare'
  /** Reads a connected third-party account. */
  | 'integration.read';

/**
 * When the user must approve before anything happens.
 *
 * `always` exists for actions whose effect leaves the account — anything
 * another person can see. `never` is for private, local, reversible work:
 * an assistant that asks twice about saving a note is worse than useless.
 *
 * There is no `sometimes`. A policy that depends on runtime values is a
 * policy nobody can read off the page, and this is the one table where
 * being able to read the rule matters most.
 */
export type ConfirmationPolicy = 'never' | 'always';

/** How a duplicate is recognised. */
export type IdempotencyStrategy =
  /**
   * The pending action's own id. Natural for anything created from one
   * confirmation: approving twice, or a reconnect replaying the approval,
   * is the same action and must happen once.
   */
  | 'pending-action'
  /**
   * The pending action plus a digest of the parameters. For actions a
   * client may legitimately repeat with different content.
   */
  | 'pending-action-and-params';

/**
 * What a handler needs from the application.
 *
 * Passed in rather than captured in a closure, which is what lets every
 * definition be a module-level constant: the registry is then genuinely
 * static data that can be read — and that the capability table can read —
 * without constructing anything.
 */
export interface ActionDeps {
  readonly prisma: PrismaService;
  /**
   * Third-party connections.
   *
   * Typed structurally rather than by importing `ConnectionsService`, which
   * would make this file depend on the integration module and turn a data
   * declaration into a cycle. The one method a handler needs is the one
   * that is named.
   */
  readonly integrations: {
    execute(
      userId: string,
      provider: ConnectionProvider,
      operation: string,
      input: Record<string, unknown>,
      meta?: { deviceId?: string },
    ): Promise<{
      fidelity: 'verified' | 'accepted' | 'prepared';
      detail: string;
      providerRef: string | null;
      data: unknown;
      connectorKind: string;
    }>;
  };
}

/** The shape a handler receives. Nothing here comes from a model. */
export interface ActionContext {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string | null;
  readonly pendingActionId: string;
  /** Deadline for the whole attempt, already applied by the executor. */
  readonly signal: AbortSignal;
  readonly deps: ActionDeps;
}

/**
 * What a handler reports.
 *
 * `status` is the handler's own assessment and the executor does not
 * upgrade it. In particular a handler that cannot read back its effect
 * returns `UNVERIFIED`, and that is what the user is told — there is no
 * path by which an unconfirmed call is presented as success.
 */
export interface ActionOutcome<T = unknown> {
  readonly status: Exclude<ExecutionStatus, 'RUNNING'>;
  /** One sentence for the user, in plain language. */
  readonly detail: string;
  /** True only when the effect was read back. */
  readonly verified: boolean;
  /** The row or object this created, where it created one. */
  readonly resultRef?: string | null;
  /** Identifier from an external provider, where one exists. */
  readonly providerRef?: string | null;
  /** Normalised failure code. Never a provider message. */
  readonly failureCode?: string | null;
  /** Payload for the client, validated against the action's result schema. */
  readonly result: T;
}

/**
 * One allow-listed action.
 *
 * Everything the engine needs to validate, authorise, preview, run and
 * report an action lives in one of these. Nothing is looked up by string
 * anywhere else, and there is no mechanism for registering one at runtime:
 * the registry is a frozen object built at module load, so the set of
 * things this backend can do is fixed when it starts.
 */
export interface ActionDefinition<Input = unknown, Result = unknown> {
  /** Stable, unique, namespaced: `notes.create`. Never a function name. */
  readonly id: string;
  readonly category: 'notes' | 'reminders' | 'apps' | 'messaging' | 'calendar';
  /** One line, shown in the capability listing and in audit records. */
  readonly description: string;

  /** The only accepted input shape. Anything else is rejected. */
  readonly inputSchema: z.ZodType<Input>;
  /**
   * Parameters that must be present, named explicitly rather than derived
   * from the schema, so the requirement can be read without parsing Zod
   * and so the error can name the field.
   */
  readonly requiredParams: readonly string[];

  readonly requiredPermissions: readonly Permission[];
  /** A connected third-party account this action cannot run without. */
  readonly requiresConnection: string | null;

  readonly confirmationPolicy: ConfirmationPolicy;
  readonly idempotency: IdempotencyStrategy;

  /** Where this sits in the existing action taxonomy. */
  readonly kind: ActionKind;
  readonly executionMode: ExecutionMode;

  /** The only shape this action may return. */
  readonly resultSchema: z.ZodType<Result>;

  /**
   * The handler. A direct function reference on the definition — there is
   * no name-to-function lookup, no `eval`, and no path by which a string
   * from anywhere becomes a call.
   */
  readonly handler: (
    input: Input,
    context: ActionContext,
  ) => Promise<ActionOutcome<Result>>;

  /**
   * Turns validated parameters into the labelled fields a confirmation card
   * shows. The preview is rendered from the same values that will run, so
   * the two cannot drift.
   */
  readonly preview: (input: Input) => readonly PreviewField[];
}

export interface PreviewField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly multiline?: boolean;
}

/** A definition with its generics erased, for storage in the registry. */
export type AnyActionDefinition = ActionDefinition<never, unknown>;
