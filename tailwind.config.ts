import type { Config } from 'tailwindcss';

/**
 * Dual-theme design system.
 *
 * Colors are driven entirely by CSS custom properties (see globals.css) so the
 * same utility classes resolve to the obsidian/charcoal dark palette or the
 * alabaster/porcelain light palette depending on the `class` set by next-themes.
 * Never hard-code hex values in components — always reference these tokens.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces (obsidian → alabaster)
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--c-surface-raised) / <alpha-value>)',
        hairline: 'rgb(var(--c-hairline) / <alpha-value>)',
        // Typography (porcelain → deep charcoal)
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--c-ink-muted) / <alpha-value>)',
        'ink-faint': 'rgb(var(--c-ink-faint) / <alpha-value>)',
        // Radiant accent (the "pulse" hue)
        pulse: 'rgb(var(--c-pulse) / <alpha-value>)',
        'pulse-soft': 'rgb(var(--c-pulse-soft) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      transitionTimingFunction: {
        fluid: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.08)', opacity: '1' },
        },
        'ambient-drift': {
          '0%, 100%': { opacity: '0.35', transform: 'translate3d(0,0,0)' },
          '50%': { opacity: '0.7', transform: 'translate3d(0,-1.5%,0)' },
        },
      },
      animation: {
        breathe: 'breathe 2.4s var(--ease-fluid, ease-in-out) infinite',
        'ambient-drift': 'ambient-drift 7s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
