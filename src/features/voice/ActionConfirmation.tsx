import { useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/primitives/GlassCard';
import { Icon } from '@/components/primitives/Icon';
import { ProviderBadge } from './ProviderBadge';
import type { ProviderInfo } from '@/services/types';
import { withField, type CommandPlan } from '@/services/actions/types';

export interface ActionConfirmationProps {
  plan: CommandPlan;
  /** Epoch ms after which the request lapses, or null for no timeout. */
  deadline: number | null;
  interpreterInfo: ProviderInfo;
  onConfirm: (plan: CommandPlan) => void;
  onCancel: () => void;
  /** Start the request again by voice. */
  onRevise: () => void;
}

function useRemainingSeconds(deadline: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(() =>
    deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null,
  );

  useEffect(() => {
    if (!deadline) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  return remaining;
}

/**
 * The approval step for anything sensitive or externally visible.
 *
 * It is reusable across every action kind: the plan supplies the title, the
 * target, the fields and the wording of the primary button, so adding an
 * action never means adding another confirmation screen.
 *
 * The card states plainly what will happen. Where the frontend cannot
 * complete the action itself, the button says what it can actually do —
 * "Open in WhatsApp", not "Send" — because the user has to know the message
 * is not going anywhere on its own.
 */
export function ActionConfirmation({
  plan,
  deadline,
  interpreterInfo,
  onConfirm,
  onCancel,
  onRevise,
}: ActionConfirmationProps) {
  const [draft, setDraft] = useState<CommandPlan>(plan);
  const [editing, setEditing] = useState(false);
  const remaining = useRemainingSeconds(deadline);

  // A new plan replaces the draft outright.
  useEffect(() => {
    setDraft(plan);
    setEditing(false);
  }, [plan]);

  const editableFields = useMemo(() => draft.fields.filter((f) => f.editable), [draft.fields]);
  const accent = draft.targetColor ?? '#4cd7f6';

  return (
    <GlassCard accent={`${accent}66`} className="w-full p-space-md" role="group" aria-live="assertive">
      <div className="flex items-start justify-between gap-space-sm">
        <div className="flex min-w-0 items-center gap-space-sm">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm"
            style={{ background: `${accent}22`, color: accent }}
          >
            <Icon name={draft.glyph} size={18} />
          </span>
          <div className="min-w-0">
            <p className="font-display text-label-lg text-on-surface">{draft.title}</p>
            <p className="truncate font-body text-body-sm text-on-surface-variant">{draft.target}</p>
          </div>
        </div>
        <ProviderBadge info={interpreterInfo} />
      </div>

      <hr className="hairline my-space-sm" />

      <dl className="flex flex-col gap-space-sm">
        {draft.fields.map((field) => (
          <div key={field.key} className={field.multiline ? '' : 'flex items-baseline justify-between gap-space-md'}>
            <dt className="font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
              {field.label}
            </dt>
            {editing && field.editable ? (
              field.multiline ? (
                <textarea
                  className="mt-1 w-full resize-none rounded-sm bg-surface-container-lowest/80 p-space-sm font-body text-body-md text-on-surface outline-none ring-1 ring-outline-variant focus:ring-primary"
                  rows={3}
                  value={field.value}
                  aria-label={field.label}
                  onChange={(e) => setDraft((d) => withField(d, field.key, e.target.value))}
                />
              ) : (
                <input
                  className="min-w-0 flex-1 rounded-sm bg-surface-container-lowest/80 px-space-sm py-1 text-right font-body text-body-md text-on-surface outline-none ring-1 ring-outline-variant focus:ring-primary"
                  value={field.value}
                  aria-label={field.label}
                  onChange={(e) => setDraft((d) => withField(d, field.key, e.target.value))}
                />
              )
            ) : (
              <dd
                className={[
                  'font-body text-body-md text-on-surface',
                  field.multiline ? 'mt-1 rounded-sm bg-surface-container-lowest/60 p-space-sm' : 'text-right',
                ].join(' ')}
              >
                {field.value || <span className="text-on-surface-variant">—</span>}
              </dd>
            )}
          </div>
        ))}
      </dl>

      {draft.handoffNote ? (
        <p className="mt-space-sm flex gap-1.5 rounded-sm bg-surface-container-lowest/60 p-space-sm font-body text-body-sm text-on-surface-variant">
          <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning" />
          <span>{draft.handoffNote}</span>
        </p>
      ) : null}

      <div className="mt-space-md flex items-center gap-space-xs">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-on-surface active:scale-95"
        >
          <Icon name="close" size={16} />
          <span className="font-display text-label-md">Cancel</span>
        </button>

        {editableFields.length > 0 ? (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            className={[
              'flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full transition-colors active:scale-95',
              editing
                ? 'bg-surface-container-highest text-primary'
                : 'bg-surface-container-high/80 text-on-surface-variant hover:text-on-surface',
            ].join(' ')}
          >
            <Icon name="rule" size={16} />
            <span className="font-display text-label-md">{editing ? 'Done' : 'Edit'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onRevise}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-surface-container-high/80 text-on-surface-variant transition-colors hover:text-on-surface active:scale-95"
          >
            <Icon name="mic" size={16} />
            <span className="font-display text-label-md">Redo</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onConfirm(draft)}
          className="flex h-11 flex-[1.5] items-center justify-center gap-1.5 rounded-full bg-primary px-3 font-semibold text-on-primary transition-transform active:scale-95"
        >
          <Icon name={draft.execution === 'local' ? 'check' : draft.glyph} size={16} className="shrink-0" />
          <span className="truncate font-display text-label-md">{draft.primaryLabel}</span>
        </button>
      </div>

      {remaining !== null ? (
        <p className="mt-space-sm text-center font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
          Expires in {remaining}s · nothing happens until you confirm
        </p>
      ) : null}
    </GlassCard>
  );
}
