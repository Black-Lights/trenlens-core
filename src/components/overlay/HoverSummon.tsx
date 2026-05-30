'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { ipc, isTauri } from '@/lib/ipc';

/**
 * Reference implementation of the WEB-APP HOVER BUTTON contract.
 *
 * This is the snippet a third-party web app embeds. On hover it reveals a
 * summon affordance; clicking calls `window.__TAURI__.invoke('summon_overlay')`
 * (through our typed `ipc` wrapper). The Rust side validates the calling origin
 * against the allow-list (see capabilities/webapp-overlay.json) before showing
 * the assistant overlay. In a plain browser (`isTauri()===false`) it degrades to
 * a no-op tooltip so the same markup ships everywhere.
 *
 * See RESEARCH_AND_GUIDELINES.md §7 for the full integration contract.
 */
export function HoverSummon() {
  const [hover, setHover] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const summon = async () => {
    if (!isTauri()) {
      setNote('Open inside TrenLens Core to summon the assistant');
      setTimeout(() => setNote(null), 2200);
      return;
    }
    try {
      await ipc.summonOverlay(window.location.origin);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'summon failed');
      setTimeout(() => setNote(null), 2200);
    }
  };

  return (
    <div
      className="fixed bottom-6 right-6 z-50"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <AnimatePresence>
        {note && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="absolute bottom-full right-0 mb-3 w-56 rounded-xl border border-hairline bg-surface-raised/90 px-3 py-2 text-[12px] text-ink-muted backdrop-blur-xl"
          >
            {note}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={summon}
        aria-label="Summon TrenLens assistant"
        className="relative grid h-12 w-12 place-items-center rounded-full border border-hairline bg-surface-raised/80 backdrop-blur-xl"
        animate={{ width: hover ? 148 : 48 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* radiant pulse ring */}
        <motion.span
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ boxShadow: '0 0 24px -4px rgb(var(--c-pulse) / 0.6)' }}
          animate={{ opacity: [0.4, 0.9, 0.4] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span className="absolute left-3 grid h-6 w-6 place-items-center">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'rgb(var(--c-pulse))' }} />
        </span>
        <AnimatePresence>
          {hover && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              className="absolute right-4 whitespace-nowrap text-[12px] font-medium text-ink"
            >
              Ask TrenLens
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  );
}
