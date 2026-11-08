import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import { GlassCard } from '@/components/primitives/GlassCard';
import { ProviderBadge } from '@/features/voice/ProviderBadge';
import { useVoiceSession } from '@/features/voice/useVoiceSession';
import { DEFAULT_SCRIPT, useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInfo } from '@/services/types';

function ServiceRow({ title, info, extra }: { title: string; info: ProviderInfo; extra?: string }) {
  return (
    <div className="py-space-sm">
      <div className="flex items-center justify-between gap-space-sm">
        <span className="font-display text-label-lg text-on-surface">{title}</span>
        <ProviderBadge info={info} />
      </div>
      <p className="mt-0.5 font-body text-body-sm text-on-surface-variant">{info.label}</p>
      <p className="mt-0.5 font-body text-body-sm text-on-surface-variant/80">{extra ?? info.note}</p>
    </div>
  );
}

/**
 * Voice setup.
 *
 * Reports what each part of the pipeline really is — live service, scripted
 * stand-in, or absent — and lets the user choose a speech source explicitly.
 * A mock is never substituted silently; it has to be picked here.
 */
export function VoiceScreen() {
  const session = useVoiceSession();
  const sttChoice = useSettingsStore((s) => s.sttChoice);
  const setSttChoice = useSettingsStore((s) => s.setSttChoice);
  const scriptedPhrase = useSettingsStore((s) => s.scriptedPhrase);
  const setScriptedPhrase = useSettingsStore((s) => s.setScriptedPhrase);
  const speakReplies = useSettingsStore((s) => s.speakReplies);
  const setSpeakReplies = useSettingsStore((s) => s.setSpeakReplies);
  const confirmTimeoutSeconds = useSettingsStore((s) => s.confirmTimeoutSeconds);
  const setConfirmTimeoutSeconds = useSettingsStore((s) => s.setConfirmTimeoutSeconds);

  const { stt, sttSupported, tts, interpreter, wakeWord } = session.providers;

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-stage px-margin-sm pb-32 pt-20">
      <h1 className="mb-space-md font-display text-headline-md text-on-surface">Voice</h1>

      {/* ---- Speech source ---- */}
      <GlassCard className="mb-space-md p-space-md">
        <p className="font-display text-label-lg text-on-surface">Speech source</p>
        <p className="mt-0.5 font-body text-body-sm text-on-surface-variant">
          Where spoken commands come from. The scripted source recognises nothing — it replays a fixed
          sentence so the rest of the pipeline can be exercised.
        </p>

        <div className="mt-space-sm flex flex-col gap-space-xs">
          <button
            type="button"
            onClick={() => setSttChoice('browser')}
            aria-pressed={sttChoice === 'browser'}
            disabled={!sttSupported && sttChoice !== 'browser'}
            className={[
              'flex items-center justify-between gap-space-sm rounded-sm px-space-md py-space-sm text-left transition-colors',
              sttChoice === 'browser' ? 'bg-surface-container-highest' : 'bg-surface-container-high/60',
              !sttSupported ? 'opacity-60' : '',
            ].join(' ')}
          >
            <span>
              <span className="block font-display text-label-lg text-on-surface">Microphone</span>
              <span className="block font-body text-body-sm text-on-surface-variant">
                {sttSupported
                  ? 'Real speech recognition, with live microphone levels'
                  : 'Not available — this browser has no recognition engine'}
              </span>
            </span>
            {sttChoice === 'browser' ? <Icon name="check" size={18} className="shrink-0 text-primary" /> : null}
          </button>

          <button
            type="button"
            onClick={() => setSttChoice('scripted')}
            aria-pressed={sttChoice === 'scripted'}
            className={[
              'flex items-center justify-between gap-space-sm rounded-sm px-space-md py-space-sm text-left transition-colors',
              sttChoice === 'scripted' ? 'bg-surface-container-highest' : 'bg-surface-container-high/60',
            ].join(' ')}
          >
            <span>
              <span className="block font-display text-label-lg text-on-surface">Scripted phrase</span>
              <span className="block font-body text-body-sm text-on-surface-variant">
                For testing. No audio is captured and nothing is recognised.
              </span>
            </span>
            {sttChoice === 'scripted' ? <Icon name="check" size={18} className="shrink-0 text-warning" /> : null}
          </button>
        </div>

        {sttChoice === 'scripted' ? (
          <label className="mt-space-sm block">
            <span className="font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
              Script
            </span>
            <input
              value={scriptedPhrase}
              onChange={(e) => setScriptedPhrase(e.target.value)}
              placeholder={DEFAULT_SCRIPT}
              className="mt-1 h-11 w-full rounded-full bg-surface-container-lowest/80 px-space-md font-body text-body-md text-on-surface outline-none ring-1 ring-outline-variant focus:ring-primary"
            />
          </label>
        ) : null}
      </GlassCard>

      {/* ---- Pipeline status ---- */}
      <GlassCard className="mb-space-md px-space-md py-space-xs">
        <ServiceRow title="Speech to text" info={stt} />
        <hr className="hairline" />
        <ServiceRow title="Command understanding" info={interpreter} />
        <hr className="hairline" />
        <ServiceRow title="Speech output" info={tts} />
        <hr className="hairline" />
        <ServiceRow
          title={`Wake word — “${wakeWord.phrase}”`}
          info={wakeWord.info}
          extra={
            wakeWord.status === 'unavailable'
              ? 'Nothing is listening in the background. Enabling this from a web page would mean holding the microphone open continuously, and it still would not work with the app closed.'
              : undefined
          }
        />
      </GlassCard>

      {/* ---- Behaviour ---- */}
      <GlassCard className="mb-space-md px-space-md py-space-sm">
        <label className="flex items-center justify-between gap-space-md py-space-xs">
          <span className="min-w-0">
            <span className="block font-display text-label-lg text-on-surface">Speak replies</span>
            <span className="block font-body text-body-sm text-on-surface-variant">
              {tts.kind === 'real' ? 'Read short confirmations aloud' : 'No synthesiser on this device'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={speakReplies && tts.kind === 'real'}
            disabled={tts.kind !== 'real'}
            onChange={(e) => setSpeakReplies(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-primary disabled:opacity-40"
          />
        </label>

        <hr className="hairline" />

        <label className="flex items-center justify-between gap-space-md py-space-sm">
          <span className="min-w-0">
            <span className="block font-display text-label-lg text-on-surface">Confirmation timeout</span>
            <span className="block font-body text-body-sm text-on-surface-variant">
              How long an unanswered approval stays open before the turn is abandoned.
            </span>
          </span>
          <select
            value={confirmTimeoutSeconds}
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

      <p className="font-body text-body-sm text-on-surface-variant">
        Commands this build understands: “save a note …”, “remind me to … at …”, “send a WhatsApp message
        to … saying …”, and “open …”. Anything else is reported as unsupported rather than guessed at.
      </p>

      <Link
        to="/"
        className="mt-space-md inline-flex h-11 items-center gap-1.5 rounded-full bg-surface-container-high px-5 text-on-surface-variant transition-colors hover:text-on-surface"
      >
        <Icon name="orb" size={16} />
        <span className="font-display text-label-md">Back to the orb</span>
      </Link>
    </section>
  );
}
