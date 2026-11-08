import type { Config } from 'tailwindcss';

/**
 * "Luminescent Intelligence" design system.
 *
 * Every value here is transcribed from `DESIGN.md` of the Stitch export.
 * Two reconciliations were applied deliberately (see Chunk 1 analysis, R3):
 *   - `borderRadius.sm` (0.5rem) and `borderRadius.md` (1.5rem) are declared.
 *     The Stitch inline config omitted them, so `rounded-md` silently fell back
 *     to Tailwind's 0.375rem instead of the specified 1.5rem.
 *   - `celestial` (#3B82F6) is declared. DESIGN.md defines it as a core spectral
 *     colour but the inline config never exposed it.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* ---- Canvas & surfacing ---- */
        void: '#090a10',
        surface: '#121319',
        'surface-dim': '#121319',
        'surface-bright': '#383940',
        'surface-container-lowest': '#0d0e14',
        'surface-container-low': '#1a1b22',
        'surface-container': '#1e1f26',
        'surface-container-high': '#292930',
        'surface-container-highest': '#34343b',
        'surface-variant': '#34343b',
        background: '#121319',

        /* ---- Content ---- */
        'on-surface': '#e3e1eb',
        'on-surface-variant': '#bcc9cd',
        'on-background': '#e3e1eb',
        'inverse-surface': '#e3e1eb',
        'inverse-on-surface': '#2f3037',
        outline: '#869397',
        'outline-variant': '#3d494c',

        /* ---- Primary / Electric Cyan ---- */
        'surface-tint': '#4cd7f6',
        primary: '#4cd7f6',
        'primary-container': '#06b6d4',
        'on-primary': '#003640',
        'on-primary-container': '#00424f',
        'inverse-primary': '#00687a',
        'primary-fixed': '#acedff',
        'primary-fixed-dim': '#4cd7f6',
        'on-primary-fixed': '#001f26',
        'on-primary-fixed-variant': '#004e5c',

        /* ---- Secondary / Neon Violet ---- */
        secondary: '#d0bcff',
        'secondary-container': '#571bc1',
        'on-secondary': '#3c0091',
        'on-secondary-container': '#c4abff',
        'secondary-fixed': '#e9ddff',
        'secondary-fixed-dim': '#d0bcff',
        'on-secondary-fixed': '#23005c',
        'on-secondary-fixed-variant': '#5516be',

        /* ---- Tertiary / Vivid Magenta ---- */
        tertiary: '#fbabff',
        'tertiary-container': '#f074ff',
        'on-tertiary': '#580065',
        'on-tertiary-container': '#6a007a',
        'tertiary-fixed': '#ffd6fd',
        'tertiary-fixed-dim': '#fbabff',
        'on-tertiary-fixed': '#36003e',
        'on-tertiary-fixed-variant': '#7c008e',

        /* ---- Error ---- */
        error: '#ffb4ab',
        'on-error': '#690005',
        'error-container': '#93000a',
        'on-error-container': '#ffdad6',

        /* ---- Raw spectral emitters (glow / gradient stops) ---- */
        cyan: '#06b6d4',
        violet: '#8b5cf6',
        celestial: '#3b82f6',
        magenta: '#d946ef',

        /* ---- Functional ---- */
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444',
      },

      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },

      fontSize: {
        'display-hero': ['56px', { lineHeight: '64px', letterSpacing: '-0.03em', fontWeight: '600' }],
        'display-hero-mobile': ['38px', { lineHeight: '44px', letterSpacing: '-0.025em', fontWeight: '600' }],
        'headline-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '600' }],
        'headline-lg-mobile': ['26px', { lineHeight: '32px', letterSpacing: '-0.015em', fontWeight: '600' }],
        'headline-md': ['22px', { lineHeight: '28px', letterSpacing: '-0.01em', fontWeight: '500' }],
        'headline-sm': ['18px', { lineHeight: '24px', letterSpacing: '-0.005em', fontWeight: '500' }],
        'body-lg': ['16px', { lineHeight: '26px', letterSpacing: '-0.01em', fontWeight: '400' }],
        'body-md': ['14px', { lineHeight: '22px', letterSpacing: '-0.005em', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '18px', letterSpacing: '0em', fontWeight: '400' }],
        'label-lg': ['14px', { lineHeight: '20px', letterSpacing: '0.02em', fontWeight: '600' }],
        'label-md': ['12px', { lineHeight: '16px', letterSpacing: '0.04em', fontWeight: '600' }],
        'label-sm': ['10px', { lineHeight: '14px', letterSpacing: '0.06em', fontWeight: '700' }],
        'data-mono': ['13px', { lineHeight: '18px', letterSpacing: '0.01em', fontWeight: '500' }],
      },

      borderRadius: {
        sm: '0.5rem',
        DEFAULT: '1rem',
        md: '1.5rem',
        lg: '2rem',
        xl: '3rem',
        full: '9999px',
      },

      spacing: {
        'space-xs': '0.25rem',
        'space-sm': '0.5rem',
        'space-md': '1rem',
        'space-lg': '1.5rem',
        'space-xl': '2.5rem',
        gutter: '1.5rem',
        'gutter-sm': '0.75rem',
        'gutter-lg': '2rem',
        margin: '2rem',
        'margin-sm': '1rem',
        'margin-lg': '4rem',
      },

      maxWidth: {
        /* Chunk 1 decision: no dashboard on desktop — a capped, centred column. */
        stage: '560px',
        workspace: '1440px',
      },
    },
  },
  plugins: [],
};

export default config;
