import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/primitives/Icon';
import { GlassCard } from '@/components/primitives/GlassCard';
import { Orb } from '@/features/orb/Orb';
import { useOrbStore } from '@/stores/orbStore';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  appearanceEquals,
  DEFAULT_APPEARANCE,
  MOTIONS,
  PALETTES,
  paletteOf,
  PRESETS,
  RIMS,
  SHAPES,
  SIZES,
  type OrbAppearance,
} from '@/features/orb/appearance';

function SectionCard({
  title,
  tag,
  glyph,
  children,
}: {
  title: string;
  tag: string;
  glyph: 'orb' | 'tune' | 'apps' | 'waveform';
  children: React.ReactNode;
}) {
  return (
    <GlassCard className="p-space-md">
      <div className="mb-space-sm flex items-center justify-between gap-space-sm">
        <span className="flex items-center gap-space-xs">
          <Icon name={glyph} size={17} className="text-primary" />
          <span className="font-display text-label-lg text-on-surface">{title}</span>
        </span>
        <span className="font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
          {tag}
        </span>
      </div>
      {children}
    </GlassCard>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="font-body text-body-md text-on-surface-variant">{label}</span>
        <span className="font-display text-data-mono text-primary">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-container-highest accent-primary"
      />
    </label>
  );
}

/**
 * Orb customiser.
 *
 * The preview is the real `Orb` component with an unsaved draft passed in as
 * a prop — not a second implementation that could drift from it. Saving
 * commits the draft to the persisted appearance store, which every other
 * `Orb` on every screen already reads, so the change lands everywhere at
 * once including the floating widget.
 */
export function StyleScreen() {
  const saved = useAppearanceStore((s) => s.appearance);
  const apply = useAppearanceStore((s) => s.apply);
  const orbState = useOrbStore((s) => s.state);
  const reducedMotion = useReducedMotion();

  const [draft, setDraft] = useState<OrbAppearance>(saved);
  const [toast, setToast] = useState<string | null>(null);

  // If the saved appearance changes elsewhere, start from the new baseline.
  useEffect(() => setDraft(saved), [saved]);

  // The toast must not fire after the screen is gone.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const set = useCallback(
    <K extends keyof OrbAppearance>(key: K, value: OrbAppearance[K]) =>
      setDraft((d) => ({ ...d, [key]: value })),
    [],
  );

  const dirty = !appearanceEquals(draft, saved);
  const isDefault = appearanceEquals(draft, DEFAULT_APPEARANCE);
  const palette = useMemo(() => paletteOf(draft), [draft]);

  const activePreset = PRESETS.find((p) => appearanceEquals(p.appearance, draft));

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-workspace px-margin-sm pb-56 pt-20">
      <div className="mx-auto grid w-full max-w-[720px] gap-space-md lg:max-w-[1100px] lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
        {/* ---------------- live preview ---------------- */}
        <div className="min-w-0 lg:sticky lg:top-24">
          <GlassCard className="flex flex-col items-center p-space-md">
            <div className="mb-space-xs flex w-full items-center justify-between">
              <span className="flex items-center gap-1.5 rounded-full bg-surface-container-high/80 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span className="font-display text-label-sm uppercase tracking-[0.06em] text-primary">
                  Live preview
                </span>
              </span>
              <button
                type="button"
                onClick={() => setDraft(DEFAULT_APPEARANCE)}
                disabled={isDefault}
                className="flex h-11 items-center gap-1.5 rounded-full bg-surface-container-high/80 px-4 text-on-surface-variant transition-colors hover:text-on-surface disabled:opacity-40"
              >
                <Icon name="retry" size={15} />
                <span className="font-display text-label-md">Reset</span>
              </button>
            </div>

            {/* The same component the rest of the app renders. */}
            <Orb
              state={orbState}
              onActivate={() => {}}
              reducedMotion={reducedMotion}
              appearance={draft}
            />

            <p className="mt-space-xs text-center font-display text-data-mono text-on-surface-variant">
              {palette.label} · {SHAPES.find((s) => s.id === draft.shape)?.label} · {draft.size}px widget
            </p>
            <p className="mt-0.5 max-w-[34ch] text-center font-body text-body-sm text-on-surface-variant/75">
              Shown in the orb’s current state. Success and failure keep their own colours so they stay
              readable.
            </p>
          </GlassCard>
        </div>

        {/* ---------------- controls ---------------- */}
        <div className="flex min-w-0 flex-col gap-space-md">
          <SectionCard title="Presets" tag={`${PRESETS.length} handcrafted`} glyph="orb">
            <div className="flex flex-wrap gap-space-xs">
              {PRESETS.map((p) => {
                const active = activePreset?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDraft(p.appearance)}
                    className={[
                      'flex h-11 items-center gap-1.5 rounded-full px-4 transition-colors',
                      active
                        ? 'bg-surface-container-highest text-on-surface'
                        : 'bg-surface-container-high/60 text-on-surface-variant hover:text-on-surface',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        background: `linear-gradient(135deg, ${paletteOf(p.appearance).from}, ${paletteOf(p.appearance).to})`,
                      }}
                    />
                    <span className="font-display text-label-md">{p.label}</span>
                  </button>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Colour & light" tag="Spectral" glyph="tune">
            <div className="grid grid-cols-3 gap-space-xs sm:grid-cols-6">
              {PALETTES.map((p) => {
                const active = !draft.customColor && draft.paletteId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={p.label}
                    onClick={() => setDraft((d) => ({ ...d, paletteId: p.id, customColor: null }))}
                    className="flex flex-col items-center gap-1 rounded-sm bg-surface-container-high/50 p-2 transition-colors hover:bg-surface-container-high"
                  >
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-full"
                      style={{ background: `linear-gradient(135deg, ${p.from}, ${p.to})` }}
                    >
                      {active ? <Icon name="check" size={16} className="text-white" /> : null}
                    </span>
                    <span className="text-center font-display text-label-sm leading-tight text-on-surface-variant">
                      {p.label}
                    </span>
                  </button>
                );
              })}

              <label className="flex cursor-pointer flex-col items-center gap-1 rounded-sm bg-surface-container-high/50 p-2 transition-colors hover:bg-surface-container-high">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-outline-variant"
                  style={draft.customColor ? { background: draft.customColor } : undefined}
                >
                  {!draft.customColor ? <Icon name="tune" size={16} className="text-on-surface" /> : null}
                </span>
                <span className="text-center font-display text-label-sm leading-tight text-on-surface-variant">
                  Custom
                </span>
                <input
                  type="color"
                  className="sr-only"
                  aria-label="Custom orb colour"
                  value={draft.customColor ?? '#4cd7f6'}
                  onChange={(e) => setDraft((d) => ({ ...d, customColor: e.target.value }))}
                />
              </label>
            </div>
          </SectionCard>

          <SectionCard title="Shape" tag="Morphology" glyph="orb">
            <div className="grid grid-cols-4 gap-space-xs">
              {SHAPES.map((s) => {
                const active = draft.shape === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => set('shape', s.id)}
                    className={[
                      'flex flex-col items-center gap-1.5 rounded-sm px-2 py-space-sm transition-colors',
                      active ? 'bg-surface-container-highest' : 'bg-surface-container-high/50 hover:bg-surface-container-high',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        'h-6 w-6 border',
                        active ? 'border-primary' : 'border-outline',
                        s.id === 'circle' ? 'rounded-full' : '',
                        s.id === 'squircle' ? 'rounded-[9px]' : '',
                        s.id === 'bubble' ? 'rounded-[50%_50%_12%_50%]' : '',
                        s.id === 'prism' ? 'rotate-45 rounded-[4px]' : '',
                      ].join(' ')}
                    />
                    <span
                      className={[
                        'font-display text-label-sm',
                        active ? 'text-primary' : 'text-on-surface-variant',
                      ].join(' ')}
                    >
                      {s.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Size & glow" tag="Dimensions" glyph="tune">
            <p className="mb-space-xs font-body text-body-sm text-on-surface-variant">
              Size sets the floating widget. The main screen scales with it rather than matching it.
            </p>
            <div className="mb-space-md grid grid-cols-4 gap-space-xs">
              {SIZES.map((s) => {
                const active = draft.size === s;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    onClick={() => set('size', s)}
                    className={[
                      'h-11 rounded-full font-display text-label-md transition-colors',
                      active
                        ? 'bg-primary font-semibold text-on-primary'
                        : 'bg-surface-container-high/60 text-on-surface-variant hover:text-on-surface',
                    ].join(' ')}
                  >
                    {s}px
                  </button>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-col gap-space-md">
              <Slider label="Glow intensity" value={draft.glow} min={10} max={100} suffix="%" onChange={(v) => set('glow', v)} />
              <Slider label="Transparency" value={draft.alpha} min={20} max={100} suffix="%" onChange={(v) => set('alpha', v)} />
            </div>
          </SectionCard>

          <SectionCard title="Rim" tag="Definition" glyph="orb">
            <div className="grid grid-cols-2 gap-space-xs">
              {RIMS.map((r) => {
                const active = draft.rim === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => set('rim', r.id)}
                    className={[
                      'flex h-11 items-center justify-between rounded-full px-space-md transition-colors',
                      active ? 'bg-surface-container-highest text-primary' : 'bg-surface-container-high/50 text-on-surface-variant hover:text-on-surface',
                    ].join(' ')}
                  >
                    <span className="font-display text-label-md">{r.label}</span>
                    {active ? <Icon name="check" size={15} /> : null}
                  </button>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title="Motion" tag="Kinetic" glyph="waveform">
            <p className="mb-space-sm font-body text-body-sm text-on-surface-variant">
              How the orb behaves at rest. Listening, thinking and result animations are fixed, because
              they tell you what the assistant is doing.
            </p>
            <div className="flex flex-col gap-space-xs">
              {MOTIONS.map((m) => {
                const active = draft.motion === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => set('motion', m.id)}
                    className={[
                      'flex items-center justify-between gap-space-sm rounded-sm px-space-md py-space-sm text-left transition-colors',
                      active ? 'bg-surface-container-highest' : 'bg-surface-container-high/50 hover:bg-surface-container-high',
                    ].join(' ')}
                  >
                    <span className="min-w-0">
                      <span
                        className={[
                          'block font-display text-label-md',
                          active ? 'text-primary' : 'text-on-surface',
                        ].join(' ')}
                      >
                        {m.label}
                      </span>
                      <span className="block font-body text-body-sm text-on-surface-variant">{m.detail}</span>
                    </span>
                    {active ? <Icon name="check" size={16} className="shrink-0 text-primary" /> : null}
                  </button>
                );
              })}
            </div>
            {reducedMotion ? (
              <p className="mt-space-sm flex gap-1.5 rounded-sm bg-surface-container-lowest/60 p-space-sm font-body text-body-sm text-on-surface-variant">
                <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  Your system asks for reduced motion, so the orb is held still whichever style is
                  chosen. The preference is saved for when that changes.
                </span>
              </p>
            ) : null}
          </SectionCard>
        </div>
      </div>

      {/* ---------------- save bar ---------------- */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 flex justify-center px-margin-sm pb-24">
        <div
          className="flex w-full max-w-[1100px] items-center justify-between gap-space-md rounded-full border border-outline-variant/60 px-space-md py-space-sm shadow-[0_12px_36px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
          style={{ background: 'rgba(13, 15, 24, 0.94)' }}
        >
          <div className="min-w-0">
            <p className="font-display text-label-sm uppercase tracking-[0.06em] text-on-surface-variant">
              Applies everywhere
            </p>
            <p className="truncate font-display text-label-md text-on-surface">
              {dirty ? 'Unsaved changes' : 'Saved'}
            </p>
          </div>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              apply(draft);
              setToast('Orb appearance saved. It applies on every screen.');
            }}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-primary px-5 font-semibold text-on-primary transition-transform active:scale-95 disabled:opacity-40"
          >
            <Icon name="check" size={16} />
            <span className="font-display text-label-md">Save &amp; apply</span>
          </button>
        </div>
      </div>

      {toast ? (
        <div
          role="status"
          className="glass-floating pb-safe fixed inset-x-0 bottom-44 z-40 mx-auto flex w-fit items-center gap-1.5 rounded-full px-space-md py-space-sm"
        >
          <Icon name="check" size={16} className="text-success" />
          <span className="font-display text-label-md text-on-surface">{toast}</span>
        </div>
      ) : null}

      <Link
        to="/"
        className="mx-auto mt-space-md flex h-11 w-fit items-center gap-1.5 rounded-full bg-surface-container-high px-5 text-on-surface-variant transition-colors hover:text-on-surface"
      >
        <Icon name="orb" size={16} />
        <span className="font-display text-label-md">Back to the orb</span>
      </Link>
    </section>
  );
}
