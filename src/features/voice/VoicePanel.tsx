import { useEffect, useRef } from 'react';
import { useVoiceStore } from '@/stores/voiceStore';
import { useOrbStore } from '@/stores/orbStore';
import { TranscriptCard } from './TranscriptCard';
import { ActionConfirmation } from './ActionConfirmation';
import { ClarificationPrompt } from './ClarificationPrompt';
import { ErrorNotice, ResultNotice, UnsupportedNotice } from './ResultNotice';
import type { VoiceSession } from './useVoiceSession';

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
  // One selector per field: a whole-store subscription re-rendered every card
  // on each interim-transcript update.
  const interim = useVoiceStore((s) => s.interim);
  const transcript = useVoiceStore((s) => s.transcript);
  const transcriptSource = useVoiceStore((s) => s.transcriptSource);
  const plan = useVoiceStore((s) => s.plan);
  const clarification = useVoiceStore((s) => s.clarification);
  const outcome = useVoiceStore((s) => s.outcome);
  const unsupported = useVoiceStore((s) => s.unsupported);
  const error = useVoiceStore((s) => s.error);
  const confirmDeadline = useVoiceStore((s) => s.confirmDeadline);

  // A decision the user has to make should not be waiting below the fold.
  // On a short phone the action card can start off-screen, so it is brought
  // into view when it appears — instantly where reduced motion is asked for.
  const decisionRef = useRef<HTMLDivElement>(null);
  const awaitingDecision = orbState === 'confirmation';
  useEffect(() => {
    if (!awaitingDecision) return;
    const node = decisionRef.current;
    if (!node) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const id = requestAnimationFrame(() =>
      node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'nearest' }),
    );
    return () => cancelAnimationFrame(id);
  }, [awaitingDecision, plan, clarification]);

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
        <div ref={decisionRef}>
        <ClarificationPrompt
          clarification={clarification}
          onAnswer={session.answerClarification}
          onCancel={session.cancel}
        />
        </div>
      ) : null}

      {showConfirmation && plan ? (
        <div ref={decisionRef}>
        <ActionConfirmation
          plan={plan}
          deadline={confirmDeadline}
          interpreterInfo={session.providers.interpreter}
          onConfirm={session.approve}
          onCancel={session.reject}
          onRevise={session.revise}
        />
        </div>
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
