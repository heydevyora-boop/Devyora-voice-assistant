import { GlassCard } from '@/components/primitives/GlassCard';
import { ProviderBadge } from './ProviderBadge';
import type { ProviderInfo } from '@/services/types';
import type { VoiceInputSource } from '@/stores/voiceStore';

const SOURCE_LABEL: Record<VoiceInputSource, string> = {
  speech: 'Heard',
  typed: 'Typed',
  scripted: 'Scripted test input',
};

export interface TranscriptCardProps {
  /** Settled text for this turn. */
  transcript: string;
  /** Partial text while the user is still speaking. */
  interim: string;
  source: VoiceInputSource | null;
  sttInfo: ProviderInfo;
}

/**
 * What the assistant received, shown exactly as the engine delivered it.
 *
 * Only one turn is ever on screen: this is a voice assistant, not a chat log,
 * and a growing history would compete with the orb.
 */
export function TranscriptCard({ transcript, interim, source, sttInfo }: TranscriptCardProps) {
  const text = transcript || interim;
  if (!text) return null;

  const settled = Boolean(transcript);
  const label = settled && source ? SOURCE_LABEL[source] : 'Listening';

  return (
    <GlassCard accent="rgba(76, 215, 246, 0.4)" className="w-full p-space-md" aria-live="polite">
      <div className="mb-space-xs flex items-center justify-between gap-space-sm">
        <span className="font-display text-label-sm uppercase tracking-[0.06em] text-primary">
          {label}
        </span>
        {sttInfo.kind !== 'real' ? <ProviderBadge info={sttInfo} /> : null}
      </div>

      <p
        className={[
          'transcript-text font-display text-headline-sm leading-snug',
          settled ? 'text-on-surface' : 'text-on-surface-variant',
        ].join(' ')}
      >
        {text}
        {!settled ? <span className="text-primary">…</span> : null}
      </p>
    </GlassCard>
  );
}
