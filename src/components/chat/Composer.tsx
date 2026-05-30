'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';

/**
 * Composer / command bar. A single translucent field over the ambient field —
 * no hard container, just a hairline that brightens to the pulse hue on focus.
 *
 * Controlled by the parent so the tool palette can seed an invocation
 * (e.g. `everything::echo {"message":""}`) into it for the user to complete.
 */
export function Composer({
  value,
  onValueChange,
  onSend,
  busy,
  placeholder = 'Message TrenLens, or run a tool — e.g. "what tools can you use?" · everything::echo {"message":"hi"}',
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);

  const submit = () => {
    const t = value.trim();
    if (!t || busy) return;
    onSend(t);
    onValueChange('');
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-6">
      <motion.div
        animate={{
          borderColor: focused ? 'rgb(var(--c-pulse) / 0.6)' : 'rgb(var(--c-hairline))',
          boxShadow: focused
            ? '0 0 0 1px rgb(var(--c-pulse) / 0.25), 0 8px 40px -12px rgb(var(--c-pulse) / 0.35)'
            : '0 8px 40px -20px rgb(0 0 0 / 0.5)',
        }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-end gap-3 rounded-2xl border bg-surface-raised/70 px-4 py-3 backdrop-blur-xl"
      >
        <textarea
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          spellCheck={false}
          placeholder={placeholder}
          className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-[15px] placeholder:text-ink-faint focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || value.trim().length === 0}
          aria-label="Run"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-canvas transition-opacity disabled:opacity-30"
          style={{ background: 'rgb(var(--c-pulse))' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </motion.div>
      <p className="mt-2 text-center text-[11px] text-ink-faint">
        Enter to run · Shift+Enter for newline · <span className="font-mono">/image</span> a prompt to generate · pick a tool from the panel to prefill
      </p>
    </div>
  );
}
