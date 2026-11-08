import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import { capabilities } from '@/platform/capabilities';

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-space-md py-space-sm">
      <div className="min-w-0">
        <p className="font-display text-label-lg text-on-surface">{label}</p>
        {note ? (
          <p className="mt-0.5 font-body text-body-sm text-on-surface-variant">{note}</p>
        ) : null}
      </div>
      <span className="shrink-0 font-display text-data-mono text-primary">{value}</span>
    </div>
  );
}

/**
 * Settings is the fifth surface the Stitch export declared in its navigation
 * but never designed. For this chunk it reports what the current host can
 * actually do — no switch here promises behaviour the platform cannot deliver.
 */
export function SettingsScreen() {
  const overlayNote = capabilities.nativeOverlay
    ? 'This build runs inside a native shell that can place the orb above other windows.'
    : 'A web page cannot place a window above other applications. The always-on-top orb is provided by the native shell (Tauri or Capacitor), which is outside the frontend.';

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-stage px-margin-sm pb-32 pt-20">
      <h1 className="mb-space-md font-display text-headline-md text-on-surface">Settings</h1>

      <div className="glass-floating rounded-md px-space-md py-space-xs">
        <Row label="Host" value={capabilities.host} />
        <hr className="hairline" />
        <Row label="Platform" value={capabilities.os} />
        <hr className="hairline" />
        <Row label="Floating overlay" value={capabilities.nativeOverlay ? 'available' : 'not available'} note={overlayNote} />
        <hr className="hairline" />
        <Row
          label="Wake word"
          value={capabilities.wakeWord}
          note="No wake-word engine is bundled yet. The provider interface lands with the voice pipeline."
        />
        <hr className="hairline" />
        <Row label="Global hotkey" value={capabilities.globalHotkey ? 'available' : 'not available'} />
      </div>

      <p className="mt-space-md font-body text-body-sm text-on-surface-variant">
        Microphone permissions, wake word and connected-app controls arrive with the
        voice pipeline and the Apps surface.
      </p>

      <Link
        to="/"
        className="mt-space-md inline-flex h-10 items-center gap-1.5 rounded-full bg-surface-container-high px-5 text-on-surface-variant transition-colors hover:text-on-surface"
      >
        <Icon name="orb" size={16} />
        <span className="font-display text-label-md">Back to the orb</span>
      </Link>
    </section>
  );
}
