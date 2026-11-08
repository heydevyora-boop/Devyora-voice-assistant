import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import { GlassCard } from '@/components/primitives/GlassCard';
import { AppCard } from '@/features/apps/AppCard';
import { APP_INTEGRATIONS } from '@/services/connections/registry';
import { selectConnectionsProvider } from '@/services/connections/localProvider';
import { launchCapability } from '@/services/connections/launch';
import { ConnectionError, type Capability, type ConnectionState } from '@/services/connections/types';

/**
 * Connected applications.
 *
 * A secondary surface: it explains what the assistant can reach and on what
 * terms, and it never claims a link that has not happened. Attempting to
 * connect reports why it cannot, rather than flipping a switch.
 */
export function AppsScreen() {
  const provider = useMemo(() => selectConnectionsProvider(), []);
  const [overrides, setOverrides] = useState<Record<string, ConnectionState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stateFor = useCallback(
    (id: string): ConnectionState => overrides[id] ?? provider.state(id),
    [overrides, provider],
  );

  const handleConnect = useCallback(
    async (id: string) => {
      setBusy(id);
      setNotice(null);
      try {
        const next = await provider.connect(id);
        setOverrides((o) => ({ ...o, [id]: next }));
      } catch (cause) {
        // Nothing is marked connected. The failure is shown as-is.
        setNotice(
          cause instanceof ConnectionError ? cause.message : 'The connection attempt failed.',
        );
      } finally {
        setBusy(null);
      }
    },
    [provider],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        const next = await provider.disconnect(id);
        setOverrides((o) => ({ ...o, [id]: next }));
      } finally {
        setBusy(null);
      }
    },
    [provider],
  );

  const handleLaunch = useCallback((capability: Capability) => {
    const opened = launchCapability(capability);
    setNotice(
      opened
        ? `Opened ${capability.label.toLowerCase()}. Devyora cannot complete it for you — finish it there.`
        : 'The browser blocked the new window. Allow pop-ups and try again.',
    );
  }, []);

  const onDevice = APP_INTEGRATIONS.filter((a) => stateFor(a.id).status === 'local').length;
  const handsOff = APP_INTEGRATIONS.filter(
    (a) => stateFor(a.id).status !== 'local' && a.capabilities.some((c) => c.mode === 'assisted'),
  ).length;

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-workspace px-margin-sm pb-32 pt-20">
      <div className="mx-auto w-full max-w-[1100px]">
        <header className="mb-space-md">
          <h1 className="font-display text-headline-md text-on-surface">Connected apps</h1>
          <p className="mt-1 max-w-[62ch] font-body text-body-md text-on-surface-variant">
            What Devyora can reach, and on what terms. {onDevice} runs on this device and {handsOff} can
            hand off to their app. Account linking, which the rest need, is not available yet.
          </p>
        </header>

        {!provider.configured ? (
          <GlassCard accent="rgba(245, 158, 11, 0.45)" className="mb-space-md p-space-md">
            <div className="flex items-start gap-space-sm">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-warning/20 text-warning"
              >
                <Icon name="alert" size={18} />
              </span>
              <div className="min-w-0">
                <p className="font-display text-label-lg text-on-surface">No account linking yet</p>
                <p className="mt-0.5 max-w-[62ch] font-body text-body-md text-on-surface-variant">
                  {provider.unavailableReason}
                </p>
                <p className="mt-space-xs max-w-[62ch] font-body text-body-sm text-on-surface-variant/80">
                  Hand-off actions below work without any of this: they open the app with your content
                  filled in, and you finish the job.
                </p>
              </div>
            </div>
          </GlassCard>
        ) : null}

        {notice ? (
          <GlassCard className="mb-space-md p-space-sm" aria-live="polite">
            <div className="flex items-start gap-space-sm">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 font-body text-body-sm text-on-surface-variant">{notice}</p>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
                className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </GlassCard>
        ) : null}

        <div className="grid grid-cols-1 gap-space-md md:grid-cols-2 xl:grid-cols-3">
          {APP_INTEGRATIONS.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              state={stateFor(app.id)}
              blockedReason={provider.configured ? null : provider.unavailableReason}
              busy={busy === app.id}
              onConnect={() => void handleConnect(app.id)}
              onDisconnect={() => void handleDisconnect(app.id)}
              onLaunch={handleLaunch}
            />
          ))}
        </div>

        <GlassCard className="mt-space-md p-space-md">
          <div className="flex items-start gap-space-sm">
            <Icon name="settings" size={18} className="mt-0.5 shrink-0 text-primary" />
            <p className="min-w-0 font-body text-body-sm text-on-surface-variant">
              Access tokens are never held in the browser. When account linking arrives, authorisation
              runs on a backend and this screen only ever shows the status that backend reports.
            </p>
          </div>
        </GlassCard>

        <Link
          to="/"
          className="mt-space-md inline-flex h-11 items-center gap-1.5 rounded-full bg-surface-container-high px-5 text-on-surface-variant transition-colors hover:text-on-surface"
        >
          <Icon name="orb" size={16} />
          <span className="font-display text-label-md">Back to the orb</span>
        </Link>
      </div>
    </section>
  );
}
