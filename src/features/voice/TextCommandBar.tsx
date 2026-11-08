import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/primitives/Icon';

export interface TextCommandBarProps {
  onSubmit: (text: string) => void;
  onClose: () => void;
  autoFocus?: boolean;
}

/**
 * Typed fallback.
 *
 * Speech recognition is missing in several browsers and in some native
 * webviews. Rather than substituting a scripted transcript and letting it
 * look like speech, the assistant offers the honest alternative: type the
 * command and run the same pipeline.
 */
export function TextCommandBar({ onSubmit, onClose, autoFocus = true }: TextCommandBarProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <form
      className="flex w-full items-center gap-space-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = text.trim();
        if (!clean) return;
        setText('');
        onSubmit(clean);
      }}
    >
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Type a command…"
        aria-label="Type a command"
        className="glass h-12 min-w-0 flex-1 rounded-full px-space-md font-body text-body-md text-on-surface outline-none placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary"
      />
      <button
        type="submit"
        disabled={!text.trim()}
        aria-label="Run command"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition-transform active:scale-95 disabled:opacity-40"
      >
        <Icon name="send" size={18} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close text input"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-on-surface"
      >
        <Icon name="close" size={18} />
      </button>
    </form>
  );
}
