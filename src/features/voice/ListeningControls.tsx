import { Icon } from '@/components/primitives/Icon';
import type { GlyphName } from '@/features/orb/types';

export interface ControlSpec {
  readonly id: string;
  readonly label: string;
  readonly glyph: GlyphName;
  readonly tone: 'neutral' | 'primary';
  readonly onPress: () => void;
}

const TONE: Record<ControlSpec['tone'], string> = {
  neutral: 'bg-surface-container-high/80 text-on-surface-variant hover:text-on-surface',
  primary: 'bg-primary text-on-primary font-semibold',
};

/**
 * The controls for the current phase.
 *
 * The list is derived from state, so only legal actions are ever on screen
 * and nothing lingers once it stops applying.
 */
export interface ListeningControlsProps {
  controls: readonly ControlSpec[];
  /**
   * Hold the strip's height while empty. Needed when the column is centred,
   * because letting it collapse re-flows everything the moment a control
   * appears — and pointless once a card has top-aligned the column.
   */
  reserveHeight: boolean;
}

export function ListeningControls({ controls, reserveHeight }: ListeningControlsProps) {
  if (controls.length === 0 && !reserveHeight) return null;

  return (
    <div
      className={[
        'flex items-center justify-center gap-space-sm',
        reserveHeight ? 'min-h-[52px]' : '',
      ].join(' ')}
    >
      {controls.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={c.onPress}
          className={[
            'flex h-11 items-center gap-1.5 rounded-full px-5 transition-all active:scale-95',
            TONE[c.tone],
          ].join(' ')}
        >
          <Icon name={c.glyph} size={18} />
          <span className="font-display text-label-md">{c.label}</span>
        </button>
      ))}
    </div>
  );
}
