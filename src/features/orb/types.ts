/** The seven canonical orb states, transcribed from the Stitch state table. */
export const ORB_STATES = [
  'idle',
  'listening',
  'processing',
  'confirmation',
  'executing',
  'success',
  'error',
] as const;

export type OrbState = (typeof ORB_STATES)[number];

/** Visual + copy definition for one state. */
export interface OrbStateDefinition {
  /** Primary caption shown beneath the orb. */
  readonly label: string;
  /** Secondary line. Kept short — this is a status line, not a paragraph. */
  readonly hint: string;
  /** Glyph rendered in the orb core. */
  readonly glyph: GlyphName;
  /** Announcement politeness for screen readers. */
  readonly announce: 'polite' | 'assertive';
  /** CSS custom properties applied to the stage for this state. */
  readonly vars: Readonly<Record<string, string>>;
  /** Concentric sound rings are rendered only where they mean something. */
  readonly rings: boolean;
  /** The live audio waveform belongs to listening only. */
  readonly waveform: boolean;
  /** States the user cannot interrupt by tapping the orb. */
  readonly locked: boolean;
}

export type GlyphName =
  | 'orb'
  | 'waveform'
  | 'sync'
  | 'rule'
  | 'send'
  | 'check'
  | 'alert'
  | 'mic'
  | 'close'
  | 'retry'
  | 'settings'
  | 'apps'
  | 'tune'
  | 'person'
  | 'chevron-right'
  | 'chat'
  | 'camera'
  | 'globe'
  | 'mail'
  | 'calendar'
  | 'note';

/**
 * User-configurable orb appearance.
 * Chunk 5 (Customizer) writes this; the orb and the floating widget read it.
 * Declared here so the contract is fixed before the UI that edits it exists.
 */
export interface OrbAppearance {
  readonly shape: 'circle' | 'squircle' | 'bubble' | 'prism';
  readonly size: 44 | 56 | 72 | 96;
  readonly gradient: string;
  readonly glow: number; // 10..100
  readonly alpha: number; // 20..100
  readonly rim: 'spectral' | 'frosted' | 'minimal' | 'none';
}
