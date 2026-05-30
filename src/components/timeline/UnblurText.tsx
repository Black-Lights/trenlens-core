'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Typographic Unblur for live streams. As `text` grows, only the NEWLY arrived
 * characters mount blurred and sharpen into focus (via the `.unblur-char`
 * keyframe in globals.css); already-settled text is rendered plainly so we don't
 * re-animate the whole paragraph on every token. A trailing caret pulses while
 * `streaming` is true.
 */
export function UnblurText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const settledLen = useRef(0);
  const [, force] = useState(0);

  // When a stream completes (or resets), treat everything as settled.
  useEffect(() => {
    if (!streaming) settledLen.current = text.length;
    force((n) => n + 1);
  }, [streaming, text.length]);

  const settled = text.slice(0, settledLen.current);
  const fresh = text.slice(settledLen.current);

  // Advance the settled boundary on the next frame so `fresh` chars get one
  // animation pass before being folded into the plain (settled) run.
  useEffect(() => {
    if (!streaming || fresh.length === 0) return;
    const id = requestAnimationFrame(() => {
      settledLen.current = text.length;
      force((n) => n + 1);
    });
    return () => cancelAnimationFrame(id);
  }, [streaming, fresh.length, text.length]);

  return (
    <span className="whitespace-pre-wrap leading-relaxed text-ink">
      {settled}
      {fresh.split('').map((ch, i) => (
        <span key={settled.length + i} className="unblur-char" style={{ animationDelay: `${i * 12}ms` }}>
          {ch}
        </span>
      ))}
      {streaming && (
        <span className="ml-0.5 inline-block h-[1.05em] w-[2px] -translate-y-[1px] animate-breathe align-middle" style={{ background: 'rgb(var(--c-pulse))' }} />
      )}
    </span>
  );
}
