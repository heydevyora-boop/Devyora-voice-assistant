import { useEffect, useMemo } from 'react';
import { Orb } from '@/features/orb/Orb';
import { ORB_STATE_DEFINITIONS } from '@/features/orb/orbStates';
import { canHandle, type OrbEvent } from '@/features/orb/orbMachine';
import { disposeOrbTimers, useOrbStore } from '@/stores/orbStore';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Icon } from '@/components/primitives/Icon';
import type { GlyphName } from '@/features/orb/types';

interface SupportControl {
  event: OrbEvent;
  label: string;
  glyph: GlyphName;
  tone: 'neutral' | 'primary' | 'danger';
}

/**
 * Supporting controls are derived from the current state, so the screen only
 * ever shows an action that is legal right now.
 */
function controlsFor(state: string): SupportControl[] {
  switch (state) {
    case 'listening':
      return [{ event: { type: 'CANCEL' }, label: 'Cancel', glyph: 'close', tone: 'neutral' }];
    case 'processing':
    case 'executing':
      return [{ event: { type: 'CANCEL' }, label: 'Stop', glyph: 'close', tone: 'neutral' }];
    case 'confirmation':
      return [
        { event: { type: 'REJECT' }, label: 'Reject', glyph: 'close', tone: 'neutral' },
        { event: { type: 'REVISE' }, label: 'Revise', glyph: 'mic', tone: 'neutral' },
        { event: { type: 'APPROVE' }, label: 'Approve', glyph: 'check', tone: 'primary' },
      ];
    case 'error':
      return [
        { event: { type: 'DISMISS' }, label: 'Dismiss', glyph: 'close', tone: 'neutral' },
        { event: { type: 'RETRY' }, label: 'Retry', glyph: 'retry', tone: 'primary' },
      ];
    default:
      return [];
  }
}

const TONE_CLASS: Record<SupportControl['tone'], string> = {
  neutral: 'bg-surface-container-high/80 text-on-surface-variant hover:text-on-surface',
  primary: 'bg-primary text-on-primary font-semibold',
  danger: 'bg-error-container/40 text-error',
};

/**
 * The primary screen.
 *
 * Deliberately sparse: the orb, who is speaking, what is happening, and only
 * the controls that the current state allows. No dashboard, no telemetry, no
 * permanent cards — those were removed in the Chunk 1 simplification pass.
 */
export function HomeScreen() {
  const state = useOrbStore((s) => s.state);
  const errorReason = useOrbStore((s) => s.errorReason);
  const send = useOrbStore((s) => s.send);
  const activate = useOrbStore((s) => s.activate);
  const reducedMotion = useReducedMotion();

  const def = ORB_STATE_DEFINITIONS[state];
  const controls = useMemo(() => controlsFor(state), [state]);

  // Any timer owned by the store is cancelled when the screen goes away.
  useEffect(() => disposeOrbTimers, []);

  // Escape cancels from anywhere — an interrupted interaction always has a
  // way out that does not require hitting a specific control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canHandle(state, 'CANCEL')) send({ type: 'CANCEL' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, send]);

  return (
    <section className="flex min-h-[100dvh] flex-col items-center justify-center px-margin-sm pb-32 pt-20">
      <div className="flex w-full max-w-stage flex-col items-center">
        <Orb state={state} onActivate={activate} reducedMotion={reducedMotion} />

        {/* Status block. Fixed height so changing state cannot shift layout. */}
        <div className="mt-space-md flex min-h-[92px] flex-col items-center text-center">
          <h1
            className="font-display text-headline-md text-on-surface sm:text-headline-lg"
            aria-live={def.announce}
          >
            {def.label}
          </h1>
          <p className="mt-1 max-w-[32ch] font-body text-body-md text-on-surface-variant">
            {state === 'error' && errorReason ? errorReason : def.hint}
          </p>
        </div>

        {/* Supporting controls — present only while the state allows them. */}
        <div className="mt-space-sm flex min-h-[48px] items-center justify-center gap-space-sm">
          {controls.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => send(c.event)}
              className={[
                'flex h-11 items-center gap-1.5 rounded-full px-5 transition-all active:scale-95',
                TONE_CLASS[c.tone],
              ].join(' ')}
            >
              <Icon name={c.glyph} size={18} />
              <span className="font-display text-label-md">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
