import { useEffect, useRef } from 'react';
import { WAVEFORM_BAR_COUNT } from '@/features/voice/constants';
import { subscribeLevels } from '@/services/audio/levelBus';

/** Resting heights as a fraction of the track. Mirrors the Stitch bar rhythm. */
const REST = [0.18, 0.34, 0.55, 0.78, 1, 0.82, 0.5, 0.3, 0.16];

export interface WaveformProps {
  /**
   * Live amplitudes, 0..1 per bar. Omit to subscribe to the microphone bus,
   * which is how the app uses it; the explicit prop exists for previews.
   *
   * With no audio the bars hold a still resting silhouette. They are never
   * animated from invented values: a visualiser that moves without audio
   * behind it would misrepresent what the assistant is hearing.
   */
  levels?: readonly number[];
  className?: string;
}

/**
 * Multi-frequency bar visualiser.
 *
 * Heights are written straight to the DOM. At sixty frames a second a React
 * state update per frame would re-render the tree for a purely visual change,
 * so this component renders once and then only mutates `transform`.
 */
export function Waveform({ levels, className }: WaveformProps) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const liveRef = useRef<HTMLDivElement>(null);

  const paint = (next: readonly number[] | null) => {
    barsRef.current.forEach((bar, i) => {
      if (!bar) return;
      const v = next ? Math.min(1, Math.max(0.06, next[i] ?? 0)) : REST[i];
      bar.style.transform = `scaleY(${v.toFixed(3)})`;
      bar.style.opacity = next ? '1' : '0.5';
    });
    liveRef.current?.setAttribute('data-live', next ? 'true' : 'false');
  };

  // Explicit levels win; otherwise follow the microphone bus.
  useEffect(() => {
    if (levels) {
      paint(levels);
      return;
    }
    return subscribeLevels(paint);
  }, [levels]);

  return (
    <div
      ref={liveRef}
      className={className}
      aria-hidden="true"
      data-live="false"
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
            opacity: 0.5,
            background:
              i < 3
                ? 'var(--spectrum-celestial)'
                : i < 6
                  ? 'var(--spectrum-cyan)'
                  : 'var(--spectrum-magenta)',
          }}
        />
      ))}
    </div>
  );
}
