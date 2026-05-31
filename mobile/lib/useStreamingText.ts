'use client';

/**
 * Fake word-chunk streaming — the mobile mirror of the desktop's `UnblurText`.
 *
 * The desktop orchestrator answers in ONE `chatResult` (the agentic loop needs whole
 * tool-call blocks), so there is nothing to stream over the wire. To match the
 * desktop feel, we reveal the final text a few tokens at a time on a timer. Given the
 * full string and an `enabled` flag, returns the progressively-revealed substring and
 * a `done` flag. Disabled → the full text immediately (e.g. on reload/replay).
 */

import { useEffect, useRef, useState } from 'react';

/** Tokens (words + whitespace) revealed per tick, and the tick interval. */
const STEP = 3;
const TICK_MS = 28;

export function useStreamingText(full: string, enabled: boolean): { text: string; done: boolean } {
  // Split keeping separators so re-joining a prefix reproduces the original exactly.
  const tokensRef = useRef<string[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    tokensRef.current = full.length ? full.split(/(\s+)/) : [];
    setCount(enabled ? 0 : tokensRef.current.length);
  }, [full, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (count >= tokensRef.current.length) return;
    const t = setTimeout(() => {
      setCount((c) => Math.min(c + STEP, tokensRef.current.length));
    }, TICK_MS);
    return () => clearTimeout(t);
  }, [count, enabled]);

  const tokens = tokensRef.current;
  const done = count >= tokens.length;
  return { text: done ? full : tokens.slice(0, count).join(''), done };
}
