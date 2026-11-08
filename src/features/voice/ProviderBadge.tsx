import type { ProviderInfo } from '@/services/types';

const TONE: Record<ProviderInfo['kind'], { label: string; className: string }> = {
  real: { label: 'live', className: 'bg-primary/15 text-primary' },
  mock: { label: 'test', className: 'bg-warning/15 text-warning' },
  none: { label: 'off', className: 'bg-surface-container-high text-on-surface-variant' },
};

/**
 * Marks where a piece of information came from.
 *
 * A mock service must be visibly a mock wherever its output is shown, so a
 * scripted transcript or a pattern-matched plan can never read as something
 * the assistant genuinely heard or understood.
 */
export function ProviderBadge({ info, className }: { info: ProviderInfo; className?: string }) {
  const tone = TONE[info.kind];
  return (
    <span
      title={info.note}
      className={[
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5',
        'font-display text-label-sm uppercase tracking-[0.06em]',
        tone.className,
        className ?? '',
      ].join(' ')}
    >
      {tone.label}
    </span>
  );
}
