import { PendingActionStatus as S } from '@prisma/client';

/**
 * The permitted transitions for a proposed action.
 *
 * Written as data, like the voice session machine, so the whole lifecycle
 * can be read — and tested — in one place rather than inferred from the
 * `if` statements of whoever wrote the last caller.
 *
 * The property that matters most is what is **absent**: there is no edge
 * from `REJECTED`, `EXPIRED` or `CANCELLED` to anything. Those three are
 * terminal, and that is the mechanism by which a user's "no" is permanent.
 * A retry, a reconnect, a replayed approval or a background sweep cannot
 * route around it, because there is no route.
 */
const TRANSITIONS: Readonly<Record<S, readonly S[]>> = {
  // Awaiting a decision, or awaiting execution when none is required.
  [S.PENDING]: [S.APPROVED, S.EXECUTING, S.REJECTED, S.EXPIRED, S.CANCELLED],
  // Approved by the user; the executor may claim it.
  [S.APPROVED]: [S.EXECUTING, S.CANCELLED, S.EXPIRED],
  // Claimed. Only the attempt that claimed it may move it on.
  [S.EXECUTING]: [S.EXECUTED, S.FAILED],

  // Terminal. Nothing leaves these.
  [S.EXECUTED]: [],
  [S.FAILED]: [],
  [S.REJECTED]: [],
  [S.EXPIRED]: [],
  [S.CANCELLED]: [],
};

/** States from which nothing further happens. */
export const TERMINAL_PENDING_STATES: readonly S[] = [
  S.EXECUTED,
  S.FAILED,
  S.REJECTED,
  S.EXPIRED,
  S.CANCELLED,
];

/**
 * States that permanently prevent execution.
 *
 * Distinct from terminal: `EXECUTED` and `FAILED` are also terminal, but
 * they are terminal *because* an attempt happened. These three mean no
 * attempt may ever happen, which is a different claim and worth naming.
 */
export const EXECUTION_BARRED_STATES: readonly S[] = [S.REJECTED, S.EXPIRED, S.CANCELLED];

/** The states from which the executor is allowed to claim an action. */
export const CLAIMABLE_STATES: readonly S[] = [S.PENDING, S.APPROVED];

export function isPendingTerminal(status: S): boolean {
  return TERMINAL_PENDING_STATES.includes(status);
}

export function isExecutionBarred(status: S): boolean {
  return EXECUTION_BARRED_STATES.includes(status);
}

export function canPendingTransition(from: S, to: S): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Plain-language reason a status blocks execution, for the user. */
export function describeBlockedStatus(status: S): string {
  switch (status) {
    case S.REJECTED:
      return 'That was rejected, so it will not be carried out.';
    case S.EXPIRED:
      return 'That request expired. Nothing was carried out.';
    case S.CANCELLED:
      return 'That was cancelled, so it will not be carried out.';
    case S.EXECUTED:
      return 'That has already been carried out.';
    case S.FAILED:
      return 'That already failed and will not be retried automatically.';
    case S.EXECUTING:
      return 'That is being carried out now.';
    default:
      return 'That cannot be carried out in its current state.';
  }
}
