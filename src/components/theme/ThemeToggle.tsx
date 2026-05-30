'use client';

import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { useThemeWipe } from './ThemeTransition';

/**
 * Sun/moon toggle. It does NOT call setTheme directly — it hands the pointer
 * origin to the wipe controller so the palette change radiates from the click.
 */
export function ThemeToggle() {
  const { resolvedTheme } = useTheme();
  const { toggle } = useThemeWipe();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === 'dark';

  return (
    <button
      type="button"
      aria-label="Toggle color theme"
      onClick={(e) => toggle({ x: e.clientX, y: e.clientY })}
      className="group relative grid h-9 w-9 place-items-center rounded-full border border-hairline bg-surface-raised/70 backdrop-blur transition-colors hover:border-pulse/50"
    >
      {/* radiant ring that brightens on hover — echoes the ambient pulse hue */}
      <span className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-500 group-hover:opacity-100 [box-shadow:0_0_18px_-2px_rgb(var(--c-pulse)/0.55)]" />
      {mounted && (
        <motion.span
          key={isDark ? 'moon' : 'sun'}
          initial={{ rotate: -90, scale: 0.4, opacity: 0, filter: 'blur(6px)' }}
          animate={{ rotate: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="text-ink"
        >
          {isDark ? <MoonGlyph /> : <SunGlyph />}
        </motion.span>
      )}
    </button>
  );
}

function MoonGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinejoin="round" />
    </svg>
  );
}
function SunGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
    </svg>
  );
}
