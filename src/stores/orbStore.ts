import { create } from 'zustand';
import { AUTO_DISMISS_MS, transition, type OrbEvent } from '@/features/orb/orbMachine';
import type { OrbState } from '@/features/orb/types';

/** Minimum gap between two accepted orb activations (ms). */
const ACTIVATION_DEBOUNCE_MS = 350;

interface OrbStore {
  state: OrbState;
  /** Last failure reason reported by the pipeline, if any. */
  errorReason: string | null;
  /** Monotonic counter — lets effects key off "a new state entry", not just a value. */
  revision: number;

  send: (event: OrbEvent) => void;
  /** Convenience used by the orb button itself. */
  activate: () => void;
  cancel: () => void;
  reset: () => void;
}

let lastActivationAt = 0;
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearAutoDismiss() {
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

export const useOrbStore = create<OrbStore>((set, get) => ({
  state: 'idle',
  errorReason: null,
  revision: 0,

  send: (event) => {
    const current = get().state;
    const next = transition(current, event);

    // Illegal or no-op event: ignore it. An interrupted interaction can
    // deliver a late event after the user already moved on; dropping it is
    // the correct behaviour, not an error.
    if (next === null) return;

    // Guard against accidental double activation (double-click, touch +
    // synthesised mouse event, key repeat).
    if (event.type === 'ACTIVATE') {
      const now = Date.now();
      if (now - lastActivationAt < ACTIVATION_DEBOUNCE_MS) return;
      lastActivationAt = now;
    }

    clearAutoDismiss();

    set((s) => ({
      state: next,
      revision: s.revision + 1,
      errorReason: event.type === 'FAILED' ? (event.reason ?? null) : null,
    }));

    // Presentational auto-dismiss only. This is a display timer for a result
    // that has already happened — it never fabricates one.
    const dismissAfter = AUTO_DISMISS_MS[next];
    if (dismissAfter !== undefined) {
      autoDismissTimer = setTimeout(() => {
        autoDismissTimer = null;
        if (get().state === next) get().send({ type: 'DISMISS' });
      }, dismissAfter);
    }
  },

  activate: () => get().send({ type: 'ACTIVATE' }),
  cancel: () => get().send({ type: 'CANCEL' }),

  reset: () => {
    clearAutoDismiss();
    lastActivationAt = 0;
    set({ state: 'idle', errorReason: null, revision: 0 });
  },
}));

/** Cancel any pending timer — called on teardown so nothing fires after unmount. */
export function disposeOrbTimers(): void {
  clearAutoDismiss();
}
