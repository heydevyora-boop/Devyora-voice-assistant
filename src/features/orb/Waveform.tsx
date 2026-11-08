import { useEffect, useRef } from 'react';

const BAR_COUNT = 9;
/** Resting heights, as a fraction of the track. Mirrors the Stitch bar rhythm. */
const REST = [0.18, 0.34, 0.55, 0.78, 1, 0.82, 0.5, 0.3, 0.16];

export interface WaveformProps {
  /** Rendered only when true; the component tears its loop down otherwise. */
  active: boolean;
  /**
   * Live amplitude per bar, 0..1. Chunk 4 feeds this from an AnalyserNode.
   * While it is undefined the bars hold a calm resting silhouette rather than
   * pretending to react to audio that is not being captured.
   */
  levels?: readonly number[];
  reducedMotion: boolean;
  className?: string;
}

/**
 * Multi-frequency bar visualiser.
 *
 * Heights are written straight to the DOM through a ref rather than through
 * React state: at 60fps a state update per frame would re-render the tree
 * sixty times a second for a purely visual change.
 */
export function Waveform({ active, levels, reducedMotion, className }: WaveformProps) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    // No live input, no motion wanted, or inactive: hold the resting shape.
    if (!active || reducedMotion || levels !== undefined) return;

    let start: number | null = null;

    const tick = (now: number) => {
      if (start === null) start = now;
      const t = (now - start) / 1000;
      barsRef.current.forEach((bar, i) => {
        if (!bar) return;
        // Deterministic, cheap, non-random breathing so the bars read as
        // "ready" rather than as fabricated audio levels.
        const wave = 0.5 + 0.5 * Math.sin(t * 2.1 + i * 0.7);
        const h = REST[i] * (0.55 + wave * 0.45);
        bar.style.transform = `scaleY(${h.toFixed(3)})`;
      });
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [active, reducedMotion, levels]);

  // Real levels drive the bars directly when the audio layer supplies them.
  useEffect(() => {
    if (!levels) return;
    barsRef.current.forEach((bar, i) => {
      if (!bar) return;
      const v = Math.min(1, Math.max(0.08, levels[i] ?? 0));
      bar.style.transform = `scaleY(${v.toFixed(3)})`;
    });
  }, [levels]);

  if (!active) return null;

  return (
    <div
      className={className}
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5px',
        height: '34px',
      }}
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => (
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
            transition: 'transform 90ms linear',
            background:
              i < 3
                ? 'var(--spectrum-celestial)'
                : i < 6
                  ? 'var(--spectrum-cyan)'
                  : 'var(--spectrum-magenta)',
            boxShadow: i === 4 ? '0 0 10px var(--spectrum-cyan)' : undefined,
          }}
        />
      ))}
    </div>
  );
}
