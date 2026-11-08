import { Orb } from '@/features/orb/Orb';
import { ORB_STATE_DEFINITIONS } from '@/features/orb/orbStates';
import { useOrbStore } from '@/stores/orbStore';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { capabilities } from '@/platform/capabilities';

/**
 * Compact floating presentation.
 *
 * This is the layout a native shell loads into a small, frameless,
 * always-on-top window (desktop) or a bubble activity (Android). It renders
 * the same `Orb` component as the main screen, so the assistant's identity is
 * literally the same object in both places rather than a lookalike.
 *
 * The frontend provides the layout only. Creating the always-on-top window is
 * the native shell's job and is not something a web page can do.
 */
export function CompactScreen() {
  const state = useOrbStore((s) => s.state);
  const activate = useOrbStore((s) => s.activate);
  const reducedMotion = useReducedMotion();
  const def = ORB_STATE_DEFINITIONS[state];

  return (
    <section
      data-presentation="compact"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-space-sm bg-transparent p-space-sm"
    >
      <Orb
        state={state}
        onActivate={activate}
        reducedMotion={reducedMotion}
        presentation="compact"
      />
      <p className="text-center font-display text-label-md text-on-surface">{def.label}</p>

      {!capabilities.nativeOverlay ? (
        <p className="max-w-[26ch] text-center font-body text-body-sm text-on-surface-variant">
          Preview only — the always-on-top window is created by the native shell.
        </p>
      ) : null}
    </section>
  );
}
