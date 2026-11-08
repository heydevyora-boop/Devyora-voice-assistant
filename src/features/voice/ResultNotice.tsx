import { GlassCard } from '@/components/primitives/GlassCard';
import { Icon } from '@/components/primitives/Icon';
import type { ActionOutcome } from '@/services/actions/types';
import type { VoiceError } from '@/stores/voiceStore';

const OUTCOME_STYLE = {
  completed: { accent: 'rgba(16, 185, 129, 0.5)', color: '#10b981', glyph: 'check' as const, label: 'Done' },
  handoff: { accent: 'rgba(245, 158, 11, 0.5)', color: '#f59e0b', glyph: 'send' as const, label: 'Handed over' },
  failed: { accent: 'rgba(239, 68, 68, 0.5)', color: '#ef4444', glyph: 'alert' as const, label: 'Failed' },
};

export interface ResultNoticeProps {
  outcome: ActionOutcome;
  onDismiss: () => void;
}

/**
 * What actually happened, in the executor's own words.
 *
 * `handoff` is its own result, distinct from success: the assistant did
 * something real and verifiable — opened a draft, launched an app — but the
 * task is not finished, and the card says so rather than showing a tick.
 */
export function ResultNotice({ outcome, onDismiss }: ResultNoticeProps) {
  const style = OUTCOME_STYLE[outcome.status];

  return (
    <GlassCard accent={style.accent} className="w-full p-space-md" aria-live="polite">
      <div className="flex items-start gap-space-sm">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm"
          style={{ background: `${style.color}22`, color: style.color }}
        >
          <Icon name={style.glyph} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-label-lg" style={{ color: style.color }}>
            {style.label}
          </p>
          <p className="mt-0.5 font-body text-body-md text-on-surface-variant">{outcome.detail}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:text-on-surface"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </GlassCard>
  );
}

export interface ErrorNoticeProps {
  error: VoiceError;
  onRetry: () => void;
  onDismiss: () => void;
  /** Offered when speech is unavailable but typing still works. */
  onUseText?: () => void;
}

export function ErrorNotice({ error, onRetry, onDismiss, onUseText }: ErrorNoticeProps) {
  return (
    <GlassCard accent="rgba(239, 68, 68, 0.45)" className="w-full p-space-md" aria-live="assertive">
      <div className="flex items-start gap-space-sm">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-danger/20 text-error"
        >
          <Icon name="alert" size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-display text-label-lg text-error">{error.title}</p>
          <p className="mt-0.5 font-body text-body-md text-on-surface-variant">{error.detail}</p>
        </div>
      </div>

      <div className="mt-space-md flex items-center gap-space-xs">
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-on-surface active:scale-95"
        >
          <Icon name="close" size={16} />
          <span className="font-display text-label-md">Dismiss</span>
        </button>
        {onUseText && !error.retryable ? (
          <button
            type="button"
            onClick={onUseText}
            className="flex h-11 flex-[1.3] items-center justify-center gap-1.5 rounded-full bg-primary font-semibold text-on-primary transition-transform active:scale-95"
          >
            <Icon name="rule" size={16} />
            <span className="font-display text-label-md">Type instead</span>
          </button>
        ) : null}
        {error.retryable ? (
          <button
            type="button"
            onClick={onRetry}
            className="flex h-11 flex-[1.3] items-center justify-center gap-1.5 rounded-full bg-primary font-semibold text-on-primary transition-transform active:scale-95"
          >
            <Icon name="retry" size={16} />
            <span className="font-display text-label-md">Try again</span>
          </button>
        ) : null}
      </div>
    </GlassCard>
  );
}

export interface UnsupportedNoticeProps {
  heard: string;
  reason: string;
  onDismiss: () => void;
  onRetry: () => void;
}

/** A command that was received clearly but cannot be acted on. */
export function UnsupportedNotice({ heard, reason, onDismiss, onRetry }: UnsupportedNoticeProps) {
  return (
    <GlassCard accent="rgba(245, 158, 11, 0.45)" className="w-full p-space-md" aria-live="polite">
      <div className="flex items-start gap-space-sm">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-warning/20 text-warning"
        >
          <Icon name="alert" size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-display text-label-lg text-on-surface">Not handled yet</p>
          {heard ? (
            <p className="mt-0.5 truncate font-body text-body-sm italic text-on-surface-variant">“{heard}”</p>
          ) : null}
          <p className="mt-1 font-body text-body-md text-on-surface-variant">{reason}</p>
        </div>
      </div>

      <div className="mt-space-md flex items-center gap-space-xs">
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-on-surface active:scale-95"
        >
          <Icon name="close" size={16} />
          <span className="font-display text-label-md">Dismiss</span>
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-on-surface active:scale-95"
        >
          <Icon name="mic" size={16} />
          <span className="font-display text-label-md">Try another</span>
        </button>
      </div>
    </GlassCard>
  );
}
