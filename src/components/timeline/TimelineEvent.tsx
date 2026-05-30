'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';
import { Markdown } from './Markdown';
import { MorphingNode, type NodePhase } from './MorphingNode';
import { UnblurText } from './UnblurText';
import { imageStageToPhase, type TimelineEntry } from './types';

const enter = {
  initial: { opacity: 0, y: 10, filter: 'blur(8px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
};

/**
 * One row on the spine. The left rail holds the marker (a static node for
 * user/assistant turns, a live MorphingNode for tools); content flows right.
 * Authoring intent: NO chat bubbles — differentiation is by marker + type
 * weight, not by container shape or color fills.
 */
export function TimelineEvent({ entry }: { entry: TimelineEntry }) {
  return (
    <motion.li {...enter} className="relative grid grid-cols-[28px_1fr] gap-3 pl-1">
      {/* left rail / marker */}
      <div className="relative flex justify-center pt-1">
        {entry.kind === 'tool' ? (
          <MorphingNode phase={entry.phase} />
        ) : entry.kind === 'image' ? (
          <MorphingNode phase={imageStageToPhase(entry.stage)} />
        ) : entry.kind === 'assistant' && entry.thinking ? (
          <MorphingNode phase="processing" />
        ) : (
          <Marker kind={entry.kind} />
        )}
      </div>

      {/* content */}
      <div className="min-w-0 pb-2">
        {entry.kind === 'user' && (
          <p className="font-medium text-ink-muted">{entry.text}</p>
        )}

        {entry.kind === 'assistant' && (
          <div className="text-[15px]">
            {entry.thinking && !entry.text ? (
              <ThinkingHint />
            ) : entry.error ? (
              <p style={{ color: 'rgb(220 90 90)' }}>{entry.text}</p>
            ) : entry.streaming ? (
              // Live: per-character Typographic Unblur on the raw text.
              <UnblurText text={entry.text} streaming />
            ) : (
              // Settled: render Markdown (headings, lists, code, **bold**…),
              // easing in with the same blur→sharp mechanism.
              <Markdown text={entry.text} />
            )}
            {entry.toolsUsed && entry.toolsUsed.length > 0 && (
              <p className="mt-1 text-[11px] text-ink-faint">used {entry.toolsUsed.join(', ')}</p>
            )}
          </div>
        )}

        {entry.kind === 'tool' && (
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[12px] tracking-tight text-pulse">{entry.tool}</span>
              {entry.server && (
                <span className="text-[11px] text-ink-faint">via {entry.server}</span>
              )}
              <PhaseHint phase={entry.phase} />
            </div>
            {entry.output &&
              (entry.phase === 'dissolving' || entry.phase === 'done' || entry.phase === 'error') && (
                <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l border-hairline pl-3 font-mono text-[12px] leading-relaxed text-ink-muted">
                  <UnblurText text={entry.output} streaming={entry.streaming} />
                </div>
              )}
          </div>
        )}

        {entry.kind === 'image' && (
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[12px] tracking-tight text-pulse">generate_image</span>
              {entry.stage === 'done' && entry.route && (
                <span className="text-[11px] text-ink-faint">
                  via {entry.route}
                  {entry.classification ? ` · ${entry.classification.replace('_', ' ')}` : ''}
                </span>
              )}
              <ImageStageHint stage={entry.stage} />
            </div>

            {/* the user's raw idea */}
            <p className="mt-1 text-[13px] text-ink-muted">{entry.prompt}</p>

            {/* Stage-1 output: the expanded diffusion prompt, unblurring in */}
            {entry.expandedPrompt && entry.stage !== 'error' && (
              <div className="mt-1.5 border-l border-hairline pl-3 font-mono text-[11.5px] leading-relaxed text-ink-faint">
                <UnblurText text={entry.expandedPrompt} />
              </div>
            )}

            {/* Stage-2 output: the render, revealed with the CSS Typographic Unblur */}
            {entry.image && entry.stage === 'done' && (
              <ImageReveal src={entry.image} alt={entry.prompt} />
            )}

            {entry.stage === 'done' && entry.mock && entry.note && (
              <p className="mt-1.5 text-[11px] text-ink-faint">{entry.note}</p>
            )}

            {entry.stage === 'error' && (
              <p className="mt-1.5 text-[12px]" style={{ color: 'rgb(220 90 90)' }}>
                {entry.error ?? 'Image generation failed.'}
              </p>
            )}
          </div>
        )}
      </div>
    </motion.li>
  );
}

/**
 * Reveals a finished render with the CSS "Typographic Unblur" — the same
 * `data-unblur` mechanism the streaming text uses (globals.css). The image mounts
 * blurred + dim and sharpens into focus once it has loaded.
 */
function ImageReveal({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-2.5 max-w-sm overflow-hidden rounded-xl border border-hairline bg-surface-raised/40">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        data-unblur={shown ? 'out' : 'in'}
        onLoad={() => requestAnimationFrame(() => setShown(true))}
        className="block h-auto w-full"
      />
    </div>
  );
}

/** In-flight indicator for a conversational turn — a soft "thinking" + dot pulse. */
function ThinkingHint() {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-faint">
      thinking
      <span className="inline-flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 w-1 rounded-full"
            style={{ background: 'rgb(var(--c-pulse))' }}
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
      </span>
    </span>
  );
}

/** Stage label for an image pipeline entry, mirroring <PhaseHint>'s dot pulse. */
function ImageStageHint({ stage }: { stage: 'expanding' | 'rendering' | 'done' | 'error' }) {
  const label =
    stage === 'expanding' ? 'expanding prompt' : stage === 'rendering' ? 'rendering image' : null;
  if (!label) return null;
  return (
    <span className="text-[11px] text-ink-faint">
      {label}
      <span className="ml-1 inline-flex gap-0.5 align-middle">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 w-1 rounded-full"
            style={{ background: 'rgb(var(--c-pulse))' }}
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
      </span>
    </span>
  );
}

function Marker({ kind }: { kind: 'user' | 'assistant' }) {
  // user = hollow ring (a question opening), assistant = filled dot (a response)
  return kind === 'user' ? (
    <span className="mt-1 h-2.5 w-2.5 rounded-full border-2 border-ink-faint" />
  ) : (
    <span className="mt-1 h-2.5 w-2.5 rounded-full bg-ink-muted" />
  );
}

function PhaseHint({ phase }: { phase: NodePhase }) {
  const label =
    phase === 'spawn' || phase === 'processing'
      ? 'running'
      : phase === 'dissolving'
        ? 'resolving'
        : phase === 'error'
          ? 'failed'
          : null;
  if (!label) return null;
  return (
    <span className="text-[11px] text-ink-faint">
      {label}
      {(phase === 'processing' || phase === 'spawn') && (
        <span className="ml-1 inline-flex gap-0.5 align-middle">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1 w-1 rounded-full"
              style={{ background: 'rgb(var(--c-pulse))' }}
              animate={{ opacity: [0.2, 1, 0.2] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </span>
      )}
    </span>
  );
}
