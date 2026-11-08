import { GlassCard } from '@/components/primitives/GlassCard';
import { Icon } from '@/components/primitives/Icon';
import type { AppIntegration, Capability, CapabilityMode, ConnectionState } from '@/services/connections/types';

const MODE_BADGE: Record<CapabilityMode, { label: string; className: string }> = {
  local: { label: 'on device', className: 'bg-success/15 text-success' },
  assisted: { label: 'hand-off', className: 'bg-primary/15 text-primary' },
  account: { label: 'needs account', className: 'bg-surface-container-high text-on-surface-variant' },
};

function statusChip(state: ConnectionState, brandColor: string) {
  switch (state.status) {
    case 'local':
      return { label: 'On this device', style: { background: 'rgba(16,185,129,0.15)', color: '#10b981' } };
    case 'connected':
      return { label: 'Connected', style: { background: `${brandColor}22`, color: brandColor } };
    case 'connecting':
      return { label: 'Connecting…', style: { background: 'rgba(76,215,246,0.15)', color: '#4cd7f6' } };
    case 'error':
      return { label: 'Error', style: { background: 'rgba(239,68,68,0.15)', color: '#ffb4ab' } };
    case 'not-connected':
    default:
      return {
        label: 'Not connected',
        style: { background: 'rgba(255,255,255,0.06)', color: '#bcc9cd' },
      };
  }
}

export interface AppCardProps {
  app: AppIntegration;
  state: ConnectionState;
  /** Why connecting is impossible, when no backend is configured. */
  blockedReason: string | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onLaunch: (capability: Capability) => void;
}

/**
 * One integration.
 *
 * The status chip is whatever the connections provider reported — never an
 * optimistic guess — and each capability says plainly whether it works now,
 * hands off to the user, or is waiting on an account link that does not
 * exist. A toggle that could flip to "connected" without an authorisation
 * behind it is not offered at all.
 */
export function AppCard({ app, state, blockedReason, busy, onConnect, onDisconnect, onLaunch }: AppCardProps) {
  const chip = statusChip(state, app.brandColor);
  const linked = state.status === 'connected';
  const detail = state.status === 'connected' ? `${state.account} · since ${state.since}` : state.detail;
  const launchable = app.capabilities.filter((c) => c.mode === 'assisted' && c.launchUrl);

  return (
    <GlassCard accent={`${app.brandColor}55`} className="p-space-md">
      <div className="flex items-start justify-between gap-space-sm">
        <div className="flex min-w-0 items-center gap-space-sm">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm"
            style={{
              background: `${app.brandColor}1f`,
              color: app.brandColor,
              boxShadow: `0 0 18px ${app.brandColor}33`,
            }}
          >
            <Icon name={app.glyph} size={24} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-display text-label-lg text-on-surface">{app.name}</span>
              <span
                className="rounded-full px-2 py-0.5 font-display text-label-sm uppercase tracking-[0.06em]"
                style={chip.style}
              >
                {chip.label}
              </span>
            </div>
            <p className="mt-0.5 font-body text-body-sm text-on-surface-variant">{detail}</p>
          </div>
        </div>
      </div>

      <hr className="hairline my-space-sm" />

      <ul className="flex flex-col gap-space-xs">
        {app.capabilities.map((c) => {
          const badge = MODE_BADGE[c.mode];
          return (
            <li key={c.id} className="flex items-start justify-between gap-space-sm">
              <div className="min-w-0">
                <p
                  className={[
                    'font-display text-label-md',
                    c.mode === 'account' ? 'text-on-surface-variant' : 'text-on-surface',
                  ].join(' ')}
                >
                  {c.label}
                </p>
                <p className="font-body text-body-sm text-on-surface-variant/80">{c.note}</p>
              </div>
              <span
                className={[
                  'mt-0.5 shrink-0 rounded-full px-2 py-0.5 font-display text-label-sm uppercase tracking-[0.06em]',
                  badge.className,
                ].join(' ')}
              >
                {badge.label}
              </span>
            </li>
          );
        })}
      </ul>

      {launchable.length > 0 ? (
        <div className="mt-space-sm flex flex-wrap gap-space-xs">
          {launchable.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onLaunch(c)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-surface-container-high/80 px-3 text-on-surface transition-colors hover:bg-surface-container-highest active:scale-95"
            >
              <Icon name={app.glyph} size={14} style={{ color: app.brandColor }} />
              <span className="font-display text-label-md">{c.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {app.authScopes.length > 0 ? (
        <div className="mt-space-sm">
          {linked ? (
            <button
              type="button"
              disabled={busy}
              onClick={onDisconnect}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-error disabled:opacity-50"
            >
              <Icon name="close" size={15} />
              <span className="font-display text-label-md">Disconnect</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onConnect}
              aria-describedby={blockedReason ? `${app.id}-blocked` : undefined}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface transition-colors hover:bg-surface-container-highest disabled:opacity-50"
            >
              <Icon name="apps" size={15} />
              <span className="font-display text-label-md">
                {busy ? 'Checking…' : `Connect ${app.name}`}
              </span>
            </button>
          )}

          <p className="mt-space-xs font-body text-body-sm text-on-surface-variant/70">
            Would request: {app.authScopes.join(' · ')}
          </p>
        </div>
      ) : null}
    </GlassCard>
  );
}
