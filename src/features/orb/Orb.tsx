import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '@/components/primitives/Icon';
import { cn } from '@/components/primitives/cn';
import { ORB_STATE_DEFINITIONS } from './orbStates';
import { Waveform } from './Waveform';
import { appearanceToVars, type OrbAppearance } from './appearance';
import { useAppearanceStore } from '@/stores/appearanceStore';
import type { OrbState } from './types';

export interface OrbProps {
  state: OrbState;
  /** Fired when the user activates the orb (pointer, touch, Enter or Space). */
  onActivate: () => void;
  /** Live amplitudes, 0..1, supplied by the audio layer in Chunk 4. */
  levels?: readonly number[];
  reducedMotion?: boolean;
  /** `compact` is the small floating presentation; `full` is the main screen. */
  presentation?: 'full' | 'compact';
  /**
   * Override the saved appearance. The customiser passes its unsaved draft
   * here so the preview is this component, not a copy of it.
   */
  appearance?: OrbAppearance;
  className?: string;
}

/**
 * The orb.
 *
 * One component serves the main screen and the compact floating presentation,
 * so the assistant's identity cannot drift between them. Everything that
 * varies — colour, glow, scale, halos — is a CSS custom property written by
 * the state table, which keeps this file free of conditional styling.
 */
export function Orb({
  state,
  onActivate,
  levels,
  reducedMotion = false,
  presentation = 'full',
  appearance,
  className,
}: OrbProps) {
  const def = ORB_STATE_DEFINITIONS[state];
  const saved = useAppearanceStore((s) => s.appearance);
  const look = appearance ?? saved;
  const [pressed, setPressed] = useState(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Any pending press-release timer must not outlive the component.
  useEffect(
    () => () => {
      if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
    },
    [],
  );

  const flashPress = useCallback(() => {
    setPressed(true);
    if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => setPressed(false), 140);
  }, []);

  const handleActivate = useCallback(() => {
    if (def.locked) return; // processing / executing are not interruptible here
    flashPress();
    onActivate();
  }, [def.locked, flashPress, onActivate]);

  // A native <button> already activates on Enter (keydown) and Space (keyup),
  // and it already suppresses Space page-scroll while focused. Calling
  // preventDefault() here would cancel the Space activation outright, so the
  // handler only blocks auto-repeat and mirrors the press feedback.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') flashPress();
  }, [flashPress]);

  return (
    <div
      className={cn('orb-stage', className)}
      data-state={state}
      data-presentation={presentation}
      data-motion-style={look.motion}
      data-shape={look.shape}
      // Appearance first, then the state table: a palette may set the orb's
      // resting identity, but it must never repaint a semantic state such as
      // success or failure.
      style={{
        ...appearanceToVars(look),
        // The floating widget is exactly the size the user picked; the main
        // screen only scales with it.
        ...(presentation === 'compact'
          ? ({ '--orb-base-size': `${look.size}px`, '--orb-size-scale': '1' } as CSSProperties)
          : null),
        ...(def.vars as CSSProperties),
      }}
    >
      <div className="orb-layer orb-ambient" />
      <div className="orb-layer orb-ambient orb-ambient--secondary" />

      <div className="orb-layer orb-halo orb-halo--outer" />
      <div className="orb-layer orb-halo orb-halo--inner" />

      {def.rings && !reducedMotion ? (
        <>
          <div className="orb-layer orb-ring" />
          <div className="orb-layer orb-ring" />
          <div className="orb-layer orb-ring" />
        </>
      ) : null}

      <button
        type="button"
        className="orb-core"
        data-pressed={pressed ? 'true' : undefined}
        aria-disabled={def.locked || undefined}
        aria-label={`Assistant orb — ${def.label}. ${def.hint}`}
        onPointerDown={flashPress}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        onKeyDown={handleKeyDown}
        onClick={handleActivate}
      >
        <span className="orb-blobs">
          <span className="orb-blob orb-blob--a" />
          <span className="orb-blob orb-blob--b" />
        </span>

        <span className="orb-comet" />

        {look.motion === 'particles' && !reducedMotion ? (
          <span className="orb-motes" aria-hidden="true">
            <span className="orb-mote" />
            <span className="orb-mote" />
            <span className="orb-mote" />
            <span className="orb-mote" />
            <span className="orb-mote" />
          </span>
        ) : null}

        <span className="orb-glyph">
          <Icon
            name={def.glyph}
            size={presentation === 'compact' ? 24 : 38}
            strokeWidth={1.5}
          />
        </span>
      </button>

      {def.waveform ? (
        // Anchored inside the reserved sanctuary, so showing or hiding it
        // never moves surrounding content.
        <Waveform levels={levels} className="orb-waveform" />
      ) : null}
    </div>
  );
}
