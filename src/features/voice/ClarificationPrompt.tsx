import { useState } from 'react';
import { GlassCard } from '@/components/primitives/GlassCard';
import { Icon } from '@/components/primitives/Icon';
import type { Clarification } from '@/services/nlu/types';

export interface ClarificationPromptProps {
  clarification: Clarification;
  onAnswer: (value: string) => void;
  onCancel: () => void;
}

/**
 * Asks instead of guessing.
 *
 * When a command is ambiguous — an unresolved contact, a missing message body
 * — the assistant stops and asks. Picking a plausible interpretation and
 * acting on it is how a voice assistant sends the wrong message to the wrong
 * person, so that path does not exist here.
 */
export function ClarificationPrompt({ clarification, onAnswer, onCancel }: ClarificationPromptProps) {
  const [prompting, setPrompting] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const active = clarification.options.find((o) => o.id === prompting);

  return (
    <GlassCard accent="rgba(59, 130, 246, 0.45)" className="w-full p-space-md" role="group" aria-live="assertive">
      <div className="flex items-start gap-space-sm">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-celestial/20 text-celestial"
        >
          <Icon name="alert" size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-display text-label-lg text-on-surface">{clarification.question}</p>
          <p className="mt-0.5 font-body text-body-sm text-on-surface-variant">{clarification.reason}</p>
        </div>
      </div>

      {active?.prompt ? (
        <form
          className="mt-space-md flex items-center gap-space-xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) onAnswer(typed.trim());
          }}
        >
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={active.prompt}
            aria-label={active.prompt}
            className="h-11 min-w-0 flex-1 rounded-full bg-surface-container-lowest/80 px-space-md font-body text-body-md text-on-surface outline-none ring-1 ring-outline-variant placeholder:text-on-surface-variant focus:ring-primary"
          />
          <button
            type="submit"
            disabled={!typed.trim()}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-primary px-5 font-semibold text-on-primary transition-transform active:scale-95 disabled:opacity-40"
          >
            <Icon name="check" size={16} />
            <span className="font-display text-label-md">Use this</span>
          </button>
        </form>
      ) : (
        <div className="mt-space-md flex flex-col gap-space-xs">
          {clarification.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => (option.prompt ? setPrompting(option.id) : onAnswer(option.value ?? option.label))}
              className="flex items-center justify-between gap-space-sm rounded-sm bg-surface-container-high/70 px-space-md py-space-sm text-left transition-colors hover:bg-surface-container-highest active:scale-[0.99]"
            >
              <span className="min-w-0">
                <span className="block font-display text-label-lg text-on-surface">{option.label}</span>
                {option.detail ? (
                  <span className="block font-body text-body-sm text-on-surface-variant">{option.detail}</span>
                ) : null}
              </span>
              <Icon name="chevron-right" size={16} className="shrink-0 text-on-surface-variant" />
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="mt-space-sm flex h-10 w-full items-center justify-center gap-1.5 rounded-full text-on-surface-variant transition-colors hover:text-on-surface"
      >
        <Icon name="close" size={16} />
        <span className="font-display text-label-md">Cancel</span>
      </button>
    </GlassCard>
  );
}
