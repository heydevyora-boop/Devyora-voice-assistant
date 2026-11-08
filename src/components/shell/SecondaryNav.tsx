import { NavLink } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import type { GlyphName } from '@/features/orb/types';

interface NavItem {
  to: string;
  label: string;
  glyph: GlyphName;
}

/**
 * Secondary destinations only. The orb lives on `/`, which is reached by the
 * product name in the header, so the orb never shares the bar with a tab that
 * competes with it.
 */
const ITEMS: readonly NavItem[] = [
  { to: '/voice', label: 'Voice', glyph: 'waveform' },
  { to: '/apps', label: 'Apps', glyph: 'apps' },
  { to: '/style', label: 'Style', glyph: 'tune' },
  { to: '/settings', label: 'Settings', glyph: 'settings' },
];

export interface SecondaryNavProps {
  /**
   * Hidden while the assistant is engaged. Secondary surfaces appear only
   * when they are needed, so nothing competes with the orb mid-interaction.
   */
  hidden: boolean;
}

export function SecondaryNav({ hidden }: SecondaryNavProps) {
  return (
    <nav
      className="pb-safe fixed inset-x-0 bottom-0 z-40 flex justify-center transition-[opacity,transform] duration-300"
      style={{
        opacity: hidden ? 0 : 1,
        transform: hidden ? 'translateY(12px)' : 'none',
        pointerEvents: hidden ? 'none' : 'auto',
      }}
      aria-hidden={hidden}
      aria-label="Secondary navigation"
    >
      <div className="glass-floating mb-3 flex items-center gap-space-xs rounded-xl p-space-xs">
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                'flex min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-md px-2 py-2 transition-colors',
                isActive
                  ? 'bg-surface-container-highest/60 text-primary'
                  : 'text-on-surface-variant hover:text-on-surface',
              ].join(' ')
            }
          >
            <Icon name={item.glyph} size={20} />
            <span className="font-display text-label-sm">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
