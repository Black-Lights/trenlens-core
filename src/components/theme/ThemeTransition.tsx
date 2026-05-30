'use client';

/**
 * Fluid theme handoff.
 *
 * Instead of an instant class swap, switching themes plays a Framer Motion
 * "canvas wipe": a circle of the INCOMING canvas color expands from the click
 * origin to cover the viewport; at its apex we flip next-themes underneath, then
 * the cover dissolves — so the new palette appears to be poured over the old.
 *
 * Exposes `useThemeWipe()` so any control (the toggle, a command, the overlay)
 * can trigger the transition with a pointer origin.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface WipeState {
  active: boolean;
  x: number;
  y: number;
  /** color the cover paints with = the incoming theme's canvas */
  cover: string;
}

interface ThemeWipeCtx {
  toggle: (origin?: { x: number; y: number }) => void;
}

const Ctx = createContext<ThemeWipeCtx>({ toggle: () => {} });
export const useThemeWipe = () => useContext(Ctx);

// Canvas colors must mirror globals.css so the cover matches the next palette.
const CANVAS = { dark: 'rgb(9 10 13)', light: 'rgb(244 243 240)' } as const;

export function ThemeWipeProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [wipe, setWipe] = useState<WipeState>({ active: false, x: 0, y: 0, cover: CANVAS.dark });

  const toggle = useCallback(
    (origin?: { x: number; y: number }) => {
      const next = resolvedTheme === 'dark' ? 'light' : 'dark';
      const x = origin?.x ?? (typeof window !== 'undefined' ? window.innerWidth - 56 : 0);
      const y = origin?.y ?? 56;
      setWipe({ active: true, x, y, cover: CANVAS[next] });
      // Flip the underlying palette just before the cover reaches full extent.
      window.setTimeout(() => setTheme(next), 280);
    },
    [resolvedTheme, setTheme],
  );

  // Radius needed to reach the farthest viewport corner from the origin.
  const radius =
    typeof window !== 'undefined'
      ? Math.hypot(window.innerWidth, window.innerHeight) * 1.1
      : 1200;

  const value = useMemo(() => ({ toggle }), [toggle]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <AnimatePresence>
        {wipe.active && (
          <motion.div
            key="theme-wipe"
            aria-hidden
            className="pointer-events-none fixed inset-0 z-[200]"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } }}
          >
            <motion.span
              className="absolute rounded-full"
              style={{
                left: wipe.x,
                top: wipe.y,
                width: radius * 2,
                height: radius * 2,
                marginLeft: -radius,
                marginTop: -radius,
                background: wipe.cover,
              }}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1] }}
              onAnimationComplete={() =>
                setWipe((w) => ({ ...w, active: false }))
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </Ctx.Provider>
  );
}
