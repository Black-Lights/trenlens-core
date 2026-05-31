'use client';

import { motion } from 'framer-motion';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ImageAttachment } from '@/lib/ipc';

/**
 * Composer / command bar. A single translucent field over the ambient field —
 * no hard container, just a hairline that brightens to the pulse hue on focus.
 *
 * The textarea auto-grows with its content (up to a cap), and images can be
 * attached for vision turns. Controlled value by the parent so the tool palette
 * can seed an invocation; attachments are owned here and cleared on send.
 */
const MAX_HEIGHT = 200; // px — textarea stops growing past this and scrolls

export function Composer({
  value,
  onValueChange,
  onSend,
  busy,
  placeholder = 'Message TrenLens, or run a tool — e.g. "what tools can you use?" · everything::echo {"message":"hi"}',
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  busy: boolean;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-grow the textarea to fit its content, capped at MAX_HEIGHT.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim(), attachments.length ? attachments : undefined);
    onValueChange('');
    setAttachments([]);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const read = await Promise.all(imgs.map(fileToAttachment));
    setAttachments((a) => [...a, ...read.filter((x): x is ImageAttachment => x !== null)]);
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
        className="rounded-2xl border bg-surface-raised/70 px-4 py-3 backdrop-blur-xl"
      >
        {/* Attachment thumbnails */}
        {attachments.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-2">
            {attachments.map((att, i) => (
              <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-lg border border-hairline">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={att.dataUrl} alt={`attachment ${i + 1}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                  aria-label="Remove attachment"
                  className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-canvas/80 text-ink-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Attach image */}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label="Attach image"
            className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:text-ink disabled:opacity-30"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = ''; // allow re-selecting the same file
            }}
          />

          <textarea
            ref={taRef}
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
            style={{ maxHeight: MAX_HEIGHT }}
            className="min-h-[24px] flex-1 resize-none overflow-y-auto bg-transparent font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-[15px] placeholder:text-ink-faint focus:outline-none"
          />

          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Run"
            className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-canvas transition-opacity disabled:opacity-30"
            style={{ background: 'rgb(var(--c-pulse))' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </motion.div>
      <p className="mt-2 text-center text-[11px] text-ink-faint">
        Enter to run · Shift+Enter for newline · attach an image for vision · <span className="font-mono">/image</span> to generate
      </p>
    </div>
  );
}

/** Read an image File into an attachment (data URL + split media type / base64). */
function fileToAttachment(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      resolve(m ? { dataUrl, mediaType: m[1], data: m[2] } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
