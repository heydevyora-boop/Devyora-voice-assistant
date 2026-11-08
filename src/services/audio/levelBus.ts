/**
 * Microphone levels, deliberately kept out of React state.
 *
 * The analyser produces a new frame roughly sixty times a second. Routing
 * that through a store meant sixty state updates per second, each one
 * re-rendering the screen, the orb and the visualiser for a change that only
 * ever touches nine `transform` values.
 *
 * Subscribers receive the frame directly and write to the DOM themselves, so
 * live audio costs no renders at all. Whether the microphone is open is still
 * React state — that changes rarely and the UI genuinely depends on it.
 */
type LevelListener = (levels: readonly number[] | null) => void;

const listeners = new Set<LevelListener>();
let latest: readonly number[] | null = null;

export function publishLevels(levels: readonly number[] | null): void {
  latest = levels;
  for (const listener of listeners) listener(levels);
}

/** Returns an unsubscribe function; callers must call it on teardown. */
export function subscribeLevels(listener: LevelListener): () => void {
  listeners.add(listener);
  // Deliver the current frame immediately so a late subscriber is not blank.
  listener(latest);
  return () => {
    listeners.delete(listener);
  };
}

export function currentLevels(): readonly number[] | null {
  return latest;
}
