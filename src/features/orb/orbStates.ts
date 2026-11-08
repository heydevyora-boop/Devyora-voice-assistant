import type { OrbState, OrbStateDefinition } from './types';

/**
 * The single source of truth for how each state looks and reads.
 *
 * Values are expressed as CSS custom properties rather than utility classes:
 * the Stitch export concatenated Tailwind class names in JavaScript, which a
 * production build purges (Chunk 1, risk R1). Custom properties survive the
 * build and animate on the compositor.
 *
 * Colours come from DESIGN.md's spectral spectrum:
 *   Electric Cyan #06B6D4 — voice reception and affirmative feedback
 *   Neon Violet  #8B5CF6 — computation and machine reasoning
 *   Celestial Blue #3B82F6 — context routing and review
 *   Vivid Magenta #D946EF — generation and agentic execution
 */
export const ORB_STATE_DEFINITIONS: Readonly<Record<OrbState, OrbStateDefinition>> = {
  idle: {
    label: 'Ready',
    hint: 'Tap the orb and speak',
    glyph: 'orb',
    announce: 'polite',
    rings: false,
    waveform: false,
    locked: false,
    vars: {
      '--orb-accent': 'var(--spectrum-cyan)',
      '--orb-accent-2': 'var(--spectrum-violet)',
      '--orb-gradient':
        'linear-gradient(135deg, #0b5f72 0%, #3a2a74 55%, #2a2b55 100%)',
      '--orb-scale': '0.94',
      '--orb-glow-near': '26px',
      '--orb-glow-far': '62px',
      '--orb-glow-strength': '0.3',
      '--ambient-opacity': '0.4',
      '--halo-outer-opacity': '0.16',
      '--halo-inner-opacity': '0.1',
      '--orb-rim': '1px solid rgba(255, 255, 255, 0.1)',
    },
  },

  listening: {
    label: 'Listening',
    hint: 'Speak now — tap again to stop',
    glyph: 'waveform',
    announce: 'assertive',
    rings: true,
    waveform: true,
    locked: false,
    vars: {
      '--orb-accent': 'var(--spectrum-cyan)',
      '--orb-accent-2': 'var(--spectrum-violet)',
      '--orb-gradient':
        'linear-gradient(135deg, #06b6d4 0%, #571bc1 58%, #8b5cf6 100%)',
      '--orb-scale': '1',
      '--orb-glow-near': '48px',
      '--orb-glow-far': '96px',
      '--orb-glow-strength': '0.6',
      '--ambient-opacity': '0.7',
      '--halo-outer-opacity': '0.5',
      '--halo-inner-opacity': '0.34',
      '--orb-rim': '1px solid rgba(76, 215, 246, 0.45)',
    },
  },

  processing: {
    label: 'Thinking',
    hint: 'Working out what you asked for',
    glyph: 'sync',
    announce: 'polite',
    rings: false,
    waveform: false,
    locked: true,
    vars: {
      '--orb-accent': 'var(--spectrum-violet)',
      '--orb-accent-2': 'var(--spectrum-cyan)',
      '--orb-gradient':
        'linear-gradient(135deg, #571bc1 0%, #06b6d4 60%, #383940 100%)',
      '--orb-scale': '0.97',
      '--orb-glow-near': '40px',
      '--orb-glow-far': '88px',
      '--orb-glow-strength': '0.5',
      '--ambient-opacity': '0.62',
      '--halo-outer-opacity': '0.26',
      '--halo-inner-opacity': '0.22',
      '--orb-rim': '1px solid rgba(139, 92, 246, 0.45)',
    },
  },

  confirmation: {
    label: 'Needs your approval',
    hint: 'Review the action before it runs',
    glyph: 'rule',
    announce: 'assertive',
    rings: false,
    waveform: false,
    locked: false,
    vars: {
      '--orb-accent': 'var(--spectrum-celestial)',
      '--orb-accent-2': 'var(--spectrum-cyan)',
      '--orb-gradient':
        'linear-gradient(135deg, #3b82f6 0%, #06b6d4 55%, #571bc1 100%)',
      '--orb-scale': '1',
      '--orb-glow-near': '38px',
      '--orb-glow-far': '82px',
      '--orb-glow-strength': '0.52',
      '--ambient-opacity': '0.6',
      '--halo-outer-opacity': '0.42',
      '--halo-inner-opacity': '0.2',
      '--orb-rim': '1.5px solid rgba(59, 130, 246, 0.6)',
    },
  },

  executing: {
    label: 'Running',
    hint: 'Carrying out the action',
    glyph: 'send',
    announce: 'polite',
    rings: false,
    waveform: false,
    locked: true,
    vars: {
      '--orb-accent': 'var(--spectrum-magenta)',
      '--orb-accent-2': 'var(--spectrum-cyan)',
      '--orb-gradient':
        'linear-gradient(135deg, #d946ef 0%, #06b6d4 60%, #571bc1 100%)',
      '--orb-scale': '1.02',
      '--orb-glow-near': '46px',
      '--orb-glow-far': '94px',
      '--orb-glow-strength': '0.58',
      '--ambient-opacity': '0.68',
      '--halo-outer-opacity': '0.3',
      '--halo-inner-opacity': '0.2',
      '--orb-rim': '1px solid rgba(217, 70, 239, 0.5)',
    },
  },

  success: {
    label: 'Done',
    hint: 'The action completed',
    glyph: 'check',
    announce: 'polite',
    rings: false,
    waveform: false,
    locked: false,
    vars: {
      '--orb-accent': 'var(--spectrum-success)',
      '--orb-accent-2': 'var(--spectrum-cyan)',
      '--orb-gradient':
        'linear-gradient(135deg, #10b981 0%, #06b6d4 70%, #0b5f72 100%)',
      '--orb-scale': '1',
      '--orb-glow-near': '44px',
      '--orb-glow-far': '84px',
      '--orb-glow-strength': '0.55',
      '--ambient-opacity': '0.6',
      '--halo-outer-opacity': '0.34',
      '--halo-inner-opacity': '0.18',
      '--orb-rim': '1px solid rgba(16, 185, 129, 0.5)',
    },
  },

  error: {
    label: 'Something went wrong',
    hint: 'Tap retry, or the orb to start again',
    glyph: 'alert',
    announce: 'assertive',
    rings: false,
    waveform: false,
    locked: false,
    vars: {
      '--orb-accent': '#ef4444',
      '--orb-accent-2': '#93000a',
      '--orb-gradient':
        'linear-gradient(135deg, #93000a 0%, #ef4444 60%, #34343b 100%)',
      '--orb-scale': '0.96',
      '--orb-glow-near': '32px',
      '--orb-glow-far': '68px',
      '--orb-glow-strength': '0.4',
      '--ambient-opacity': '0.45',
      '--halo-outer-opacity': '0.3',
      '--halo-inner-opacity': '0.14',
      '--orb-rim': '1px solid rgba(255, 180, 171, 0.45)',
    },
  },
};
