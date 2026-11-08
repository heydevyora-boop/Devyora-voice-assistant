import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';

export interface AppHeaderProps {
  /** Short status word shown in the identity pill. */
  status: string;
  /** True while the assistant is actively engaged. */
  live: boolean;
}

/**
 * Minimal identity bar: who the assistant is, what it is doing, and one way
 * into settings. The Stitch header also carried a latency readout; Chunk 1
 * removed it as telemetry that competes with the orb for attention.
 */
export function AppHeader({ status, live }: AppHeaderProps) {
  return (
    <header
      className="pt-safe px-safe fixed inset-x-0 top-0 z-40 backdrop-blur-xl"
      style={{
        // The Stitch reference keeps a translucent bar here; without it,
        // content scrolling underneath is unreadable.
        background: 'linear-gradient(to bottom, rgba(18, 19, 25, 0.92), rgba(18, 19, 25, 0.62) 70%, transparent)',
      }}
    >
      <div className="mx-auto flex h-16 max-w-workspace items-center justify-between px-space-md">
        <div className="flex items-center gap-space-sm">
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
            style={{
              boxShadow: '0 0 8px rgba(76, 215, 246, 0.9)',
              opacity: live ? 1 : 0.5,
            }}
            aria-hidden="true"
          />
          <span className="font-display text-headline-sm tracking-tight text-on-surface">
            Devyora
          </span>
          <span className="font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
            {status}
          </span>
        </div>

        <Link
          to="/settings"
          className="glass flex h-11 w-11 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:text-on-surface"
          aria-label="Open settings"
        >
          <Icon name="settings" size={18} />
        </Link>
      </div>
    </header>
  );
}
