'use client';

import { AnimatePresence, motion } from 'framer-motion';

export type NodePhase = 'spawn' | 'processing' | 'dissolving' | 'done' | 'error';

/**
 * Morphing Node — the visual vocabulary for a tool execution. It is NOT a badge
 * or pill. A minimalist ring/dot that:
 *   spawn       → a dot blooms into a ring
 *   processing  → the ring "breathes" (scale + opacity) with an orbiting tracer
 *   dissolving  → the ring blurs/expands and fades as its output unblurs in
 *   done/error  → settles to a small solid/again-hollow marker on the spine
 *
 * The node sits ON the timeline spine; `label` (the tool name) and any output
 * are rendered by the parent <TimelineEvent>, keeping this purely geometric.
 */
export function MorphingNode({ phase }: { phase: NodePhase }) {
  const breathing = phase === 'processing';
  const dissolving = phase === 'dissolving';

  return (
    <span className="relative grid h-6 w-6 place-items-center">
      {/* halo — present while alive, fades on dissolve */}
      <AnimatePresence>
        {(breathing || phase === 'spawn') && (
          <motion.span
            className="absolute inset-0 rounded-full"
            style={{ background: 'radial-gradient(circle, rgb(var(--c-pulse)/0.45), transparent 65%)' }}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={
              breathing
                ? { opacity: [0.3, 0.7, 0.3], scale: [1, 1.45, 1] }
                : { opacity: 0.5, scale: 1.1 }
            }
            exit={{ opacity: 0, scale: 1.8 }}
            transition={{ duration: breathing ? 2.2 : 0.5, repeat: breathing ? Infinity : 0, ease: 'easeInOut' }}
          />
        )}
      </AnimatePresence>

      {/* the ring/dot body */}
      <motion.span
        className="relative block rounded-full border"
        style={{ borderColor: 'rgb(var(--c-pulse))' }}
        initial={{ width: 5, height: 5, borderWidth: 3, opacity: 0 }}
        animate={
          dissolving
            ? { width: 26, height: 26, borderWidth: 1, opacity: 0, filter: 'blur(6px)' }
            : phase === 'done'
              ? { width: 9, height: 9, borderWidth: 4.5, opacity: 1, filter: 'blur(0px)' }
              : phase === 'error'
                ? { width: 12, height: 12, borderWidth: 2, opacity: 1 }
                : breathing
                  ? { width: 16, height: 16, borderWidth: 2, opacity: 1, scale: [1, 1.12, 1] }
                  : { width: 14, height: 14, borderWidth: 2, opacity: 1 } // spawn
        }
        transition={
          breathing
            ? { scale: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' }, default: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } }
            : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }
        }
      />

      {/* orbiting tracer — only while processing; signals live work */}
      {breathing && (
        <motion.span
          className="absolute left-1/2 top-1/2 h-[3px] w-[3px] rounded-full"
          style={{ background: 'rgb(var(--c-pulse))', marginLeft: -1.5, marginTop: -10 }}
          animate={{ rotate: 360 }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
        />
      )}

      {phase === 'error' && (
        <span className="absolute h-[10px] w-[10px] rounded-full" style={{ background: 'rgb(220 90 90)' }} />
      )}
    </span>
  );
}
