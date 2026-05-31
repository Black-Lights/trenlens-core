'use client';

/**
 * Chat composer: an auto-growing textarea + send button. Enter sends; Shift+Enter
 * inserts a newline (desktop-composer parity). Disabled while offline or sending.
 */

import { useRef, useState } from 'react';

export function Composer({ disabled, onSend }: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        placeholder="Message your desktop…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="button"
        className="composer-send"
        onClick={submit}
        disabled={disabled || !text.trim()}
        aria-label="Send"
      >
        ↑
      </button>
    </div>
  );
}
