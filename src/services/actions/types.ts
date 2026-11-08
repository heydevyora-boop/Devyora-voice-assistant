import type { GlyphName } from '@/features/orb/types';

export type ActionKind =
  | 'note.save'
  | 'reminder.create'
  | 'message.whatsapp'
  | 'app.open'
  | 'assistant.reply';

/**
 * How far the frontend can take an action on its own.
 *
 * - `local`     — the app performs it and can verify the result.
 * - `assisted`  — the app can only prepare it and hand it to the user or to
 *                 another application. It must never report this as sent.
 * - `unsupported` — nothing can be done yet; say so plainly.
 */
export type ExecutionMode = 'local' | 'assisted' | 'unsupported';

export interface PlanField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Whether the confirmation card lets the user change it before running. */
  readonly editable: boolean;
  /** Longer values render as a block rather than a single line. */
  readonly multiline?: boolean;
}

export interface CommandPlan {
  readonly id: string;
  readonly kind: ActionKind;
  /** e.g. "WhatsApp message" */
  readonly title: string;
  /** The app or surface the action touches, e.g. "WhatsApp". */
  readonly target: string;
  readonly targetColor?: string;
  readonly glyph: GlyphName;
  readonly fields: readonly PlanField[];
  readonly execution: ExecutionMode;
  /**
   * Sensitive or externally visible actions must be approved first. Local,
   * private and reversible actions run straight away.
   */
  readonly requiresConfirmation: boolean;
  /** What the assistant says aloud when the action resolves. */
  readonly spokenReply?: string;
  /** Shown on the confirmation card when execution is not `local`. */
  readonly handoffNote?: string;
  /** Label for the primary button, e.g. "Open WhatsApp". */
  readonly primaryLabel: string;
}

export type ActionOutcome =
  | { readonly status: 'completed'; readonly detail: string }
  /** Something verifiable happened, but the user still has to finish it. */
  | { readonly status: 'handoff'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string };

export interface ActionExecutor {
  /** True when this executor can run the given plan in the current host. */
  canRun: (plan: CommandPlan) => boolean;
  run: (plan: CommandPlan) => Promise<ActionOutcome>;
}

export function fieldValue(plan: CommandPlan, key: string): string {
  return plan.fields.find((f) => f.key === key)?.value ?? '';
}

export function withField(plan: CommandPlan, key: string, value: string): CommandPlan {
  return { ...plan, fields: plan.fields.map((f) => (f.key === key ? { ...f, value } : f)) };
}
