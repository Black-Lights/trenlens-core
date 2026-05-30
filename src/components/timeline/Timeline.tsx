'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { TimelineEvent } from './TimelineEvent';
import type { TimelineEntry } from './types';

/**
 * The fluid, continuous timeline. A single living spine runs down the left rail;
 * entries attach to it. A travelling light packet animates along the spine while
 * `active`, reinforcing the "data stream movement" cue. Auto-scrolls to the tail
 * as new entries arrive.
 */
export function Timeline({ entries, active }: { entries: TimelineEntry[]; active: boolean }) {
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length, entries[entries.length - 1]]);

  return (
    <div className="relative mx-auto w-full max-w-3xl px-6">
      {/* the spine */}
      <div className="pointer-events-none absolute bottom-0 left-[19px] top-0 w-px">
        <div className="h-full w-full bg-gradient-to-b from-transparent via-hairline to-transparent" />
        {active && (
          <motion.div
            className="absolute left-[-1px] h-16 w-[3px] rounded-full"
            style={{ background: 'linear-gradient(to bottom, transparent, rgb(var(--c-pulse)), transparent)' }}
            animate={{ top: ['-10%', '100%'] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
      </div>

      <ul className="relative space-y-5 py-8">
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <TimelineEvent key={entry.id} entry={entry} />
          ))}
        </AnimatePresence>
      </ul>
      <div ref={tail} />
    </div>
  );
}
