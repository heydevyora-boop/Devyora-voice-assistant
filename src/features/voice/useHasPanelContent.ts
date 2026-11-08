import { useOrbStore } from '@/stores/orbStore';
import { useVoiceStore } from '@/stores/voiceStore';

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
