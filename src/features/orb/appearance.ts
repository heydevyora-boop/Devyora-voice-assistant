import type { CSSProperties } from 'react';

/**
 * User-controlled orb appearance.
 *
 * One model, one pure translation to CSS custom properties, consumed by the
 * single `Orb` component. The customiser's preview is that same component
 * with a draft passed in, so there is no second orb implementation that could
 * drift from the real one.
 */
export type OrbShape = 'circle' | 'squircle' | 'bubble' | 'prism';
export type OrbRim = 'spectral' | 'frosted' | 'minimal' | 'none';
export type OrbMotion = 'breathing' | 'ripple' | 'audio' | 'orbital' | 'particles' | 'static';
/** Size of the floating widget in px; the main screen scales with it. */
export type OrbSize = 44 | 56 | 72 | 96;

export interface OrbAppearance {
  readonly paletteId: string;
  /** Set when the palette is a custom colour rather than a preset. */
  readonly customColor: string | null;
  readonly shape: OrbShape;
  readonly size: OrbSize;
  /** 10–100. */
  readonly glow: number;
  /** 20–100. */
  readonly alpha: number;
  readonly rim: OrbRim;
  readonly motion: OrbMotion;
}

export interface Palette {
  readonly id: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** Transcribed from the Stitch customiser's swatch grid. */
export const PALETTES: readonly Palette[] = [
  { id: 'cyan-violet', label: 'Electric Cyan', from: '#06b6d4', to: '#8b5cf6' },
  { id: 'neon-sunset', label: 'Neon Sunset', from: '#f074ff', to: '#ff8a00' },
  { id: 'celestial', label: 'Celestial Blue', from: '#3b82f6', to: '#06b6d4' },
  { id: 'emerald', label: 'Emerald Aura', from: '#10b981', to: '#06b6d4' },
  { id: 'magenta', label: 'Liquid Magenta', from: '#fbabff', to: '#7c008e' },
];

export const SHAPES: ReadonlyArray<{ id: OrbShape; label: string }> = [
  { id: 'circle', label: 'Circle' },
  { id: 'squircle', label: 'Squircle' },
  { id: 'bubble', label: 'Bubble' },
  { id: 'prism', label: 'Prism' },
];

export const SIZES: readonly OrbSize[] = [44, 56, 72, 96];

export const RIMS: ReadonlyArray<{ id: OrbRim; label: string }> = [
  { id: 'spectral', label: 'Spectral neon' },
  { id: 'frosted', label: 'Frosted edge' },
  { id: 'minimal', label: 'Minimal hairline' },
  { id: 'none', label: 'Borderless' },
];

export const MOTIONS: ReadonlyArray<{ id: OrbMotion; label: string; detail: string }> = [
  { id: 'breathing', label: 'Breathing pulse', detail: 'Gentle harmonic expansion while idle' },
  { id: 'ripple', label: 'Acoustic ripple', detail: 'Concentric rings radiating outward' },
  { id: 'audio', label: 'Audio responsive', detail: 'Still at rest; reacts only to your voice' },
  { id: 'orbital', label: 'Orbital ring', detail: 'A light node travelling the rim' },
  { id: 'particles', label: 'Floating motes', detail: 'Weightless specks suspended around the core' },
  { id: 'static', label: 'Static glass', detail: 'Calm, non-kinetic surface' },
];

export const DEFAULT_APPEARANCE: OrbAppearance = {
  paletteId: 'cyan-violet',
  customColor: null,
  shape: 'circle',
  size: 72,
  glow: 75,
  alpha: 90,
  rim: 'spectral',
  motion: 'breathing',
};

export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly appearance: OrbAppearance;
}

/** The five handcrafted presets from the Stitch customiser. */
export const PRESETS: readonly Preset[] = [
  { id: 'default', label: 'Default', appearance: DEFAULT_APPEARANCE },
  {
    id: 'midnight',
    label: 'Midnight Neon',
    appearance: { ...DEFAULT_APPEARANCE, paletteId: 'magenta', size: 56, glow: 90, alpha: 95, motion: 'orbital' },
  },
  {
    id: 'glass',
    label: 'Pure Glass',
    appearance: {
      ...DEFAULT_APPEARANCE,
      paletteId: 'celestial',
      shape: 'bubble',
      glow: 30,
      alpha: 60,
      rim: 'frosted',
      motion: 'static',
    },
  },
  {
    id: 'aurora',
    label: 'Cyber Aurora',
    appearance: {
      ...DEFAULT_APPEARANCE,
      paletteId: 'neon-sunset',
      shape: 'squircle',
      size: 96,
      glow: 100,
      alpha: 95,
      motion: 'ripple',
    },
  },
  {
    id: 'stealth',
    label: 'Stealth',
    appearance: {
      ...DEFAULT_APPEARANCE,
      paletteId: 'celestial',
      shape: 'prism',
      size: 44,
      glow: 15,
      alpha: 85,
      rim: 'minimal',
      motion: 'static',
    },
  },
];

export function paletteOf(appearance: OrbAppearance): Palette {
  if (appearance.customColor) {
    return { id: 'custom', label: 'Custom', from: appearance.customColor, to: appearance.customColor };
  }
  return PALETTES.find((p) => p.id === appearance.paletteId) ?? PALETTES[0];
}

/** Radius for a shape, expressed relative to the rendered orb size. */
function radiusFor(shape: OrbShape): string {
  switch (shape) {
    case 'squircle':
      return 'calc(var(--orb-size) * 0.32)';
    case 'bubble':
      // A teardrop: three round corners and one tight one.
      return '50% 50% 12% 50%';
    case 'prism':
      return 'calc(var(--orb-size) * 0.18)';
    case 'circle':
    default:
      return '9999px';
  }
}

function rimFor(rim: OrbRim): string {
  switch (rim) {
    case 'spectral':
      return '2px solid color-mix(in srgb, var(--orb-accent) 70%, transparent)';
    case 'frosted':
      return '2px solid rgba(255, 255, 255, 0.45)';
    case 'minimal':
      return '1px solid rgba(255, 255, 255, 0.2)';
    case 'none':
    default:
      return '1px solid transparent';
  }
}

/** The main screen scales with the chosen widget size without matching it. */
const SIZE_SCALE: Record<OrbSize, string> = {
  44: '0.78',
  56: '0.9',
  72: '1',
  96: '1.16',
};

/**
 * Translate an appearance into CSS custom properties.
 *
 * Pure and side-effect free, so the same call serves the live preview, the
 * main screen and the compact floating presentation.
 *
 * Note what is deliberately absent: the per-state accent colours. A green
 * "done" and a red "failure" carry meaning, and letting a palette repaint
 * them would make the orb unreadable. The palette drives the orb's resting
 * identity; the state table keeps the semantics.
 */
export function appearanceToVars(appearance: OrbAppearance): CSSProperties {
  const palette = paletteOf(appearance);
  return {
    '--orb-user-from': palette.from,
    '--orb-user-to': palette.to,
    '--orb-user-gradient': `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`,
    '--orb-radius': radiusFor(appearance.shape),
    '--orb-rotate': appearance.shape === 'prism' ? '45deg' : '0deg',
    '--orb-size-scale': SIZE_SCALE[appearance.size],
    '--orb-glow-scale': String(appearance.glow / 75),
    '--orb-alpha': String(appearance.alpha / 100),
    '--orb-rim': rimFor(appearance.rim),
  } as CSSProperties;
}

export function appearanceEquals(a: OrbAppearance, b: OrbAppearance): boolean {
  return (
    a.paletteId === b.paletteId &&
    a.customColor === b.customColor &&
    a.shape === b.shape &&
    a.size === b.size &&
    a.glow === b.glow &&
    a.alpha === b.alpha &&
    a.rim === b.rim &&
    a.motion === b.motion
  );
}
