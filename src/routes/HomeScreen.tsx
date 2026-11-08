import { useEffect, useMemo, useState } from 'react';
import { Orb } from '@/features/orb/Orb';
import { ORB_STATE_DEFINITIONS } from '@/features/orb/orbStates';
import { canHandle } from '@/features/orb/orbMachine';
import { disposeOrbTimers, useOrbStore } from '@/stores/orbStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useVoiceSession } from '@/features/voice/useVoiceSession';
import { useHasPanelContent, VoicePanel } from '@/features/voice/VoicePanel';
import { ListeningControls, type ControlSpec } from '@/features/voice/ListeningControls';
import { TextCommandBar } from '@/features/voice/TextCommandBar';
import { Icon } from '@/components/primitives/Icon';

/**
 * The primary screen.
 *
 * The orb, what is happening, and only the controls the current phase allows.
 * Everything else is contextual: cards appear while a turn is live and
 * disappear with it, so at rest the screen is the orb and nothing else.
 */
export function HomeScreen() {
  const state = useOrbStore((s) => s.state);
  const orbErrorReason = useOrbStore((s) => s.errorReason);
  const reducedMotion = useReducedMotion();
  const session = useVoiceSession();

  const levels = useVoiceStore((s) => s.levels);
  const micActive = useVoiceStore((s) => s.micActive);
  const voiceError = useVoiceStore((s) => s.error);
  const outcome = useVoiceStore((s) => s.outcome);
  const unsupported = useVoiceStore((s) => s.unsupported);
  const plan = useVoiceStore((s) => s.plan);
  const clarification = useVoiceStore((s) => s.clarification);

  const [typing, setTyping] = useState(false);
  const panelOpen = useHasPanelContent();

  const def = ORB_STATE_DEFINITIONS[state];

  // Timers owned by the orb store must not outlive this screen.
  useEffect(() => disposeOrbTimers, []);

  // Escape always has to get the user out, from any phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (typing) return; // the text bar handles its own Escape
      if (canHandle(state, 'CANCEL')) session.cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, session, typing]);

  const controls = useMemo<ControlSpec[]>(() => {
    switch (state) {
      case 'listening':
        return [
          { id: 'cancel', label: 'Cancel', glyph: 'close', tone: 'neutral', onPress: session.cancel },
          { id: 'stop', label: 'Stop', glyph: 'check', tone: 'primary', onPress: session.stopListening },
        ];
      case 'processing':
      case 'executing':
        return [{ id: 'stop', label: 'Stop', glyph: 'close', tone: 'neutral', onPress: session.cancel }];
      case 'confirmation':
        // Normally the confirmation card carries its own controls. If the
        // orb is in this phase with nothing to show — a cleared turn, a
        // restored session — the user still needs an exit.
        return plan || clarification
          ? []
          : [{ id: 'cancel', label: 'Cancel', glyph: 'close', tone: 'neutral', onPress: session.cancel }];
      case 'error':
        // The error card carries its own Dismiss and Try again. Only offer
        // them here when no card is on screen to hold them, so a failure is
        // never a dead end.
        return voiceError || unsupported
          ? []
          : [
              { id: 'dismiss', label: 'Dismiss', glyph: 'close', tone: 'neutral', onPress: session.dismiss },
              { id: 'retry', label: 'Retry', glyph: 'retry', tone: 'primary', onPress: session.retry },
            ];
      default:
        return [];
    }
  }, [state, session, voiceError, unsupported, plan, clarification]);

  // The status line prefers what actually happened over the generic copy.
  const hint =
    state === 'error'
      ? (voiceError?.detail ?? orbErrorReason ?? def.hint)
      : state === 'listening' && !micActive && session.providers.stt.kind === 'mock'
        ? 'Replaying a scripted phrase — no audio is being captured'
        : outcome && state === 'idle'
          ? outcome.detail
          : def.hint;

  return (
    <section
      data-panel={panelOpen ? 'open' : 'closed'}
      className={[
        'flex min-h-[100dvh] flex-col items-center px-margin-sm pb-32',
        panelOpen ? 'justify-start pt-20' : 'justify-center pt-20',
      ].join(' ')}
    >
      <div className="flex w-full max-w-stage flex-col items-center">
        <Orb
          state={state}
          onActivate={session.toggle}
          levels={levels ?? undefined}
          reducedMotion={reducedMotion}
        />

        {/* Fixed height so a state change cannot shift the layout. */}
        {/* Reserved height so a state change cannot shift the layout. */}
        <div className="mt-space-md flex min-h-[92px] flex-col items-center text-center">
          <h1 className="font-display text-headline-md text-on-surface sm:text-headline-lg" aria-live={def.announce}>
            {def.label}
          </h1>
          <p className="mt-1 max-w-[36ch] font-body text-body-md text-on-surface-variant">{hint}</p>
        </div>

        <ListeningControls controls={controls} />

        <VoicePanel session={session} onUseText={() => setTyping(true)} />

        {/* Typed fallback, offered without being in the way. The row keeps
            its height in every phase so the centred column never re-flows. */}
        <div className="mt-space-md flex min-h-[48px] w-full items-start justify-center">
          {typing ? (
            <TextCommandBar
              onSubmit={(text) => {
                setTyping(false);
                session.submitTypedCommand(text);
              }}
              onClose={() => setTyping(false)}
            />
          ) : state === 'idle' ? (
            <button
              type="button"
              onClick={() => setTyping(true)}
              className="flex h-9 items-center gap-1.5 rounded-full px-3 text-on-surface-variant transition-colors hover:text-on-surface"
            >
              <Icon name="rule" size={15} />
              <span className="font-display text-label-md">Type instead</span>
            </button>
          ) : null}
        </div>

        {/* Speech recognition missing: say so once, up front. */}
        {state === 'idle' && !session.providers.sttSupported ? (
          <p className="mt-space-sm max-w-[40ch] text-center font-body text-body-sm text-on-surface-variant">
            This browser has no speech recognition. Type your command, or pick a speech source on the{' '}
            <a className="text-primary underline underline-offset-2" href="#/voice">
              Voice
            </a>{' '}
            screen.
          </p>
        ) : null}
      </div>
    </section>
  );
}
