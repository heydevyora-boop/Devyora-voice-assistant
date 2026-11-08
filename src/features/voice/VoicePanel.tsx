import { useVoiceStore } from '@/stores/voiceStore';
import { useOrbStore } from '@/stores/orbStore';
import { TranscriptCard } from './TranscriptCard';
import { ActionConfirmation } from './ActionConfirmation';
import { ClarificationPrompt } from './ClarificationPrompt';
import { ErrorNotice, ResultNotice, UnsupportedNotice } from './ResultNotice';
import type { VoiceSession } from './useVoiceSession';

/**
 * Whether the contextual panel currently has anything to show.
 *
 * The screen layout depends on this — a centred orb with nothing beneath it
 * at rest, and a top-aligned column once a card appears — so the condition
 * lives in one place rather than being restated by each consumer.
 */
export function useHasPanelContent(): boolean {
  const orbState = useOrbStore((s) => s.state);
  const interim = useVoiceStore((s) => s.interim);
  const transcript = useVoiceStore((s) => s.transcript);
  const plan = useVoiceStore((s) => s.plan);
  const clarification = useVoiceStore((s) => s.clarification);
  const outcome = useVoiceStore((s) => s.outcome);
  const unsupported = useVoiceStore((s) => s.unsupported);
  const error = useVoiceStore((s) => s.error);

  const showTranscript = Boolean(transcript || interim) && orbState !== 'idle' && !error;
  const showConfirmation = orbState === 'confirmation' && (plan !== null || clarification !== null);
  const showOutcome = outcome !== null && outcome.status !== 'failed' && !error;

  return showTranscript || showConfirmation || showOutcome || unsupported !== null || error !== null;
}

export interface VoicePanelProps {
  session: VoiceSession;
  /** Offer the typed fallback from an error notice. */
  onUseText: () => void;
}

/**
 * The contextual surface beneath the orb.
 *
 * Nothing here is permanent: each card appears only while it has something to
 * say about the current turn, and the whole panel is empty at rest so the orb
 * stands alone.
 */
export function VoicePanel({ session, onUseText }: VoicePanelProps) {
  const orbState = useOrbStore((s) => s.state);
  const { interim, transcript, transcriptSource, plan, clarification, outcome, unsupported, error, confirmDeadline } =
    useVoiceStore();

  const showTranscript =
    Boolean(transcript || interim) && orbState !== 'idle' && !error;

  const showConfirmation = orbState === 'confirmation' && plan !== null && clarification === null;
  const showClarification = orbState === 'confirmation' && clarification !== null;
  // A handoff returns the orb to idle, so its notice must survive that.
  const showOutcome = outcome !== null && outcome.status !== 'failed' && !error;

  if (!showTranscript && !showConfirmation && !showClarification && !showOutcome && !unsupported && !error) {
    return null;
  }

  return (
    <div className="mt-space-sm flex w-full flex-col gap-space-sm">
      {showTranscript ? (
        <TranscriptCard
          transcript={transcript}
          interim={interim}
          source={transcriptSource}
          sttInfo={session.providers.stt}
        />
      ) : null}

      {showClarification && clarification ? (
        <ClarificationPrompt
          clarification={clarification}
          onAnswer={session.answerClarification}
          onCancel={session.cancel}
        />
      ) : null}

      {showConfirmation && plan ? (
        <ActionConfirmation
          plan={plan}
          deadline={confirmDeadline}
          interpreterInfo={session.providers.interpreter}
          onConfirm={session.approve}
          onCancel={session.reject}
          onRevise={session.revise}
        />
      ) : null}

      {showOutcome && outcome ? <ResultNotice outcome={outcome} onDismiss={session.dismiss} /> : null}

      {unsupported ? (
        <UnsupportedNotice
          heard={unsupported.heard}
          reason={unsupported.reason}
          onDismiss={session.dismiss}
          onRetry={session.retry}
        />
      ) : null}

      {error ? (
        <ErrorNotice
          error={error}
          onRetry={session.retry}
          onDismiss={session.dismiss}
          onUseText={onUseText}
        />
      ) : null}
    </div>
  );
}
