import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import { GlassCard } from '@/components/primitives/GlassCard';
import { capabilities } from '@/platform/capabilities';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { paletteOf } from '@/features/orb/appearance';
import { selectTts } from '@/services/tts';
import { localStore } from '@/services/actions/localExecutor';
import type { GlyphName } from '@/features/orb/types';

function NavRow({
  to,
  glyph,
  title,
  detail,
}: {
  to: string;
  glyph: GlyphName;
  title: string;
  detail: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-w-0 items-center justify-between gap-space-sm px-space-md py-space-sm transition-colors hover:bg-surface-container-high/40"
    >
      <span className="flex min-w-0 items-center gap-space-sm">
        <Icon name={glyph} size={18} className="shrink-0 text-primary" />
        <span className="min-w-0">
          <span className="block truncate font-display text-label-lg text-on-surface">{title}</span>
          <span className="block truncate font-body text-body-sm text-on-surface-variant">{detail}</span>
        </span>
      </span>
      <Icon name="chevron-right" size={16} className="shrink-0 text-on-surface-variant" />
    </Link>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="py-space-sm">
      <div className="flex items-baseline justify-between gap-space-md">
        <span className="font-display text-label-lg text-on-surface">{label}</span>
        <span className="shrink-0 font-display text-data-mono text-primary">{value}</span>
      </div>
      {note ? <p className="mt-0.5 font-body text-body-sm text-on-surface-variant">{note}</p> : null}
    </div>
  );
}

type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Settings.
 *
 * A short hub, not a dashboard: the handful of preferences that have nowhere
 * better to live, pointers to the surfaces that own the rest, and a plain
 * account of what this app stores and what leaves the device.
 */
export function SettingsScreen() {
  const speakReplies = useSettingsStore((s) => s.speakReplies);
  const setSpeakReplies = useSettingsStore((s) => s.setSpeakReplies);
  const confirmTimeoutSeconds = useSettingsStore((s) => s.confirmTimeoutSeconds);
  const setConfirmTimeoutSeconds = useSettingsStore((s) => s.setConfirmTimeoutSeconds);
  const appearance = useAppearanceStore((s) => s.appearance);
  const [tts] = useState(() => selectTts());
  const [micPermission, setMicPermission] = useState<MicPermission>('unknown');
  const [cleared, setCleared] = useState(false);
  const [counts, setCounts] = useState(() => ({
    notes: localStore.notes().length,
    reminders: localStore.reminders().length,
  }));

  // Report the real permission state where the browser exposes it.
  useEffect(() => {
    let alive = true;
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (!alive) return;
        setMicPermission(status.state as MicPermission);
        status.onchange = () => setMicPermission(status.state as MicPermission);
      })
      .catch(() => {
        /* Firefox and Safari do not expose the microphone permission. */
      });
    return () => {
      alive = false;
    };
  }, []);

  const clearLocalData = useCallback(() => {
    try {
      localStorage.removeItem('devyora.notes');
      localStorage.removeItem('devyora.reminders');
    } catch {
      /* storage unavailable: nothing was stored to begin with */
    }
    setCounts({ notes: localStore.notes().length, reminders: localStore.reminders().length });
    setCleared(true);
  }, []);

  const micLabel: Record<MicPermission, string> = {
    granted: 'allowed',
    denied: 'blocked',
    prompt: 'asks each time',
    unknown: 'not reported',
  };

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-workspace px-margin-sm pb-32 pt-20">
      {/* One readable column until there is room for two, rather than one
          stretched the full width of a tablet. */}
      <div className="mx-auto grid w-full max-w-[720px] gap-space-md lg:max-w-[1100px] lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-space-md">
          <h1 className="font-display text-headline-md text-on-surface lg:col-span-2">Settings</h1>

          {/* ---- Where everything else lives ---- */}
          <GlassCard className="overflow-hidden py-space-xs">
            <NavRow
              to="/voice"
              glyph="waveform"
              title="Voice & language"
              detail="Speech source, spoken replies, wake-word status"
            />
            <hr className="hairline mx-space-md" />
            <NavRow
              to="/style"
              glyph="tune"
              title="Orb appearance"
              detail={`${paletteOf(appearance).label} · ${appearance.shape} · ${appearance.size}px widget`}
            />
            <hr className="hairline mx-space-md" />
            <NavRow
              to="/apps"
              glyph="apps"
              title="Connected apps"
              detail="What Devyora can reach, and on what terms"
            />
          </GlassCard>

          {/* ---- Assistant preferences ---- */}
          <GlassCard className="px-space-md py-space-sm">
            <p className="mb-space-xs font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
              Assistant
            </p>

            <label className="flex items-center justify-between gap-space-md py-space-xs">
              <span className="min-w-0">
                <span className="block font-display text-label-lg text-on-surface">Speak replies</span>
                <span className="block font-body text-body-sm text-on-surface-variant">
                  {tts.info.kind === 'real' ? 'Read short confirmations aloud' : 'No speech synthesiser on this device'}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={speakReplies && tts.info.kind === 'real'}
                disabled={tts.info.kind !== 'real'}
                onChange={(e) => setSpeakReplies(e.target.checked)}
                className="h-5 w-5 shrink-0 accent-primary disabled:opacity-40"
              />
            </label>

            <hr className="hairline" />

            <label className="flex items-center justify-between gap-space-md py-space-sm">
              <span className="min-w-0">
                <span className="block font-display text-label-lg text-on-surface">
                  Confirmation timeout
                </span>
                <span className="block font-body text-body-sm text-on-surface-variant">
                  How long an unanswered approval stays open
                </span>
              </span>
              <select
                value={confirmTimeoutSeconds}
                aria-label="Confirmation timeout"
                onChange={(e) => setConfirmTimeoutSeconds(Number(e.target.value))}
                className="h-11 shrink-0 rounded-full bg-surface-container-lowest/80 px-space-sm font-display text-label-md text-on-surface outline-none ring-1 ring-outline-variant focus:ring-primary"
              >
                <option value={0}>Never</option>
                <option value={30}>30s</option>
                <option value={60}>60s</option>
                <option value={90}>90s</option>
                <option value={180}>3 min</option>
              </select>
            </label>
          </GlassCard>
        </div>

        <div className="flex min-w-0 flex-col gap-space-md">
          {/* ---- Permissions and privacy ---- */}
          <GlassCard className="px-space-md py-space-xs">
            <p className="py-space-xs font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
              Permissions & privacy
            </p>
            <Fact
              label="Microphone"
              value={micLabel[micPermission]}
              note="Opened only while you are speaking to the orb, and released the moment the turn ends."
            />
            <hr className="hairline" />
            <Fact
              label="Speech recognition"
              value={capabilities.host === 'browser' ? 'browser engine' : capabilities.host}
              note="On Chrome and Edge the Web Speech API sends audio to Google for transcription. Nothing is recorded by Devyora."
            />
            <hr className="hairline" />
            <Fact
              label="Stored on this device"
              value={`${counts.notes + counts.reminders} items`}
              note="Notes, reminders and your preferences. No account tokens are stored in the browser, by design."
            />
            <hr className="hairline" />
            <Fact
              label="Sent to a server"
              value="nothing"
              note="There is no Devyora backend in this build. Hand-off actions open another app in a new tab; what you send there is between you and that app."
            />

            <div className="py-space-sm">
              <button
                type="button"
                onClick={clearLocalData}
                disabled={counts.notes + counts.reminders === 0}
                className="flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-error disabled:opacity-40"
              >
                <Icon name="close" size={15} />
                <span className="font-display text-label-md">Delete notes & reminders</span>
              </button>
              {cleared ? (
                <p role="status" className="mt-space-xs text-center font-body text-body-sm text-success">
                  Deleted from this device.
                </p>
              ) : null}
            </div>
          </GlassCard>

          {/* ---- Account ---- */}
          <GlassCard className="p-space-md">
            <p className="font-display text-label-lg text-on-surface">Account</p>
            <p className="mt-0.5 font-body text-body-md text-on-surface-variant">
              Devyora has no sign-in. Everything runs on this device, so there is nothing to log into
              and nothing to sync. Account settings will appear here once connected apps need one.
            </p>
          </GlassCard>

          <Link
            to="/"
            className="inline-flex h-11 w-fit items-center gap-1.5 rounded-full bg-surface-container-high px-5 text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <Icon name="orb" size={16} />
            <span className="font-display text-label-md">Back to the orb</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
