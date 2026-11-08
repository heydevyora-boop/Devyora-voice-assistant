import { ORB_STATES } from '@/features/orb/types';
import { ORB_STATE_DEFINITIONS } from '@/features/orb/orbStates';
import { Orb } from '@/features/orb/Orb';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * Development-only state gallery.
 *
 * The Stitch export shipped a row of buttons that let anyone force the orb
 * into any state, with the caption "Tap orb or buttons above to change state".
 * That is a design-review tool, not product UI, so it is not part of the
 * assistant. It lives here instead, mounted only when `import.meta.env.DEV`
 * is true, so every state stays reviewable without shipping a way to fake one.
 */
export function StatePreviewScreen() {
  const reducedMotion = useReducedMotion();

  return (
    <section className="mx-auto w-full max-w-workspace px-margin-sm pb-32 pt-20">
      <h1 className="mb-1 font-display text-headline-md text-on-surface">Orb states</h1>
      <p className="mb-space-lg font-body text-body-sm text-on-surface-variant">
        Development preview. Not part of the shipped interface.
      </p>

      <div className="grid grid-cols-1 gap-space-lg sm:grid-cols-2 xl:grid-cols-3">
        {ORB_STATES.map((state) => (
          <article
            key={state}
            data-testid={`state-card-${state}`}
            className="glass flex flex-col items-center rounded-md p-space-sm"
          >
            <div className="scale-[0.62]">
              <Orb state={state} onActivate={() => {}} reducedMotion={reducedMotion} />
            </div>
            <p className="font-display text-label-sm uppercase tracking-[0.06em] text-primary">
              {state}
            </p>
            <p className="mt-0.5 font-display text-label-lg text-on-surface">
              {ORB_STATE_DEFINITIONS[state].label}
            </p>
            <p className="text-center font-body text-body-sm text-on-surface-variant">
              {ORB_STATE_DEFINITIONS[state].hint}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
