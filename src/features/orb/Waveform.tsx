import { useEffect, useRef } from 'react';
import { WAVEFORM_BAR_COUNT } from '@/features/voice/constants';

/** Resting heights as a fraction of the track. Mirrors the Stitch bar rhythm. */
const REST = [0.18, 0.34, 0.55, 0.78, 1, 0.82, 0.5, 0.3, 0.16];

export interface WaveformProps {
  /**
   * Live amplitude per bar, 0..1, from the microphone's analyser.
   *
   * When this is absent the bars hold a still resting silhouette. They are
   * never animated from invented values: a visualiser that moves without
   * audio behind it would misrepresent what the assistant is hearing.
   */
  levels?: readonly number[];
  className?: string;
}

/**
 * Multi-frequency bar visualiser.
 *
 * Heights are written straight to the DOM through a ref rather than through
 * React state — at 60fps, a state update per frame would re-render the tree
 * sixty times a second for a purely visual change.
 */
export function Waveform({ levels, className }: WaveformProps) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    barsRef.current.forEach((bar, i) => {
      if (!bar) return;
      const v = levels ? Math.min(1, Math.max(0.06, levels[i] ?? 0)) : REST[i];
      bar.style.transform = `scaleY(${v.toFixed(3)})`;
    });
  }, [levels]);

  return (
    <div
      className={className}
      aria-hidden="true"
      data-live={levels ? 'true' : 'false'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5px',
        height: '34px',
      }}
    >
      {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          style={{
            display: 'block',
            width: i === 4 ? '4px' : '3px',
            height: '100%',
            borderRadius: '9999px',
            transformOrigin: 'center',
            transform: `scaleY(${REST[i]})`,
            transition: 'transform 70ms linear',
            opacity: levels ? 1 : 0.5,
            background:
              i < 3
                ? 'var(--spectrum-celestial)'
                : i < 6
                  ? 'var(--spectrum-cyan)'
                  : 'var(--spectrum-magenta)',
            boxShadow: i === 4 && levels ? '0 0 10px var(--spectrum-cyan)' : undefined,
          }}
        />
      ))}
    </div>
  );
}
