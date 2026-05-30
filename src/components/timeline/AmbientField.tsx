'use client';

import { motion } from 'framer-motion';

/**
 * Backdrop ambient field. Two slow-drifting radial blooms in the `pulse` hue
 * plus a faint grain. When `active` (a backend stream is moving) the blooms
 * intensify and quicken — this is the "data stream movement" signal. Opacity is
 * driven by the theme token `--ambient-opacity` so it stays subtle/translucent
 * in light mode and more radiant against obsidian in dark mode.
 */
export function AmbientField({ active = false }: { active?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <motion.div
        className="absolute -left-1/4 top-[-20%] h-[70vh] w-[70vh] rounded-full blur-[120px]"
        style={{
          background: 'radial-gradient(circle, rgb(var(--c-pulse) / var(--ambient-opacity)) 0%, transparent 70%)',
        }}
        animate={{
          x: active ? [0, 60, 0] : [0, 24, 0],
          y: active ? [0, -40, 0] : [0, -16, 0],
          scale: active ? [1, 1.12, 1] : [1, 1.04, 1],
        }}
        transition={{ duration: active ? 8 : 16, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute bottom-[-25%] right-[-15%] h-[60vh] w-[60vh] rounded-full blur-[140px]"
        style={{
          background: 'radial-gradient(circle, rgb(var(--c-pulse-soft) / var(--ambient-opacity)) 0%, transparent 72%)',
        }}
        animate={{
          x: active ? [0, -50, 0] : [0, -20, 0],
          y: active ? [0, 30, 0] : [0, 12, 0],
          scale: active ? [1, 1.15, 1] : [1, 1.05, 1],
        }}
        transition={{ duration: active ? 9 : 18, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* hairline grain to kill banding on the large blurs */}
      <div
        className="absolute inset-0 mix-blend-overlay"
        style={{
          opacity: 'var(--grain-opacity)',
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}
