'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef } from 'react';

/**
 * Reusable confirmation popup — a token-styled, animated modal that replaces the
 * browser's native `window.confirm` (which renders an ugly "localhost says…" box).
 * Mirrors `AboutDialog`'s overlay/dialog motion. Closes on backdrop click or Esc;
 * Enter confirms. Render it at the PAGE level (a sibling of the main content), not
 * inside a transformed container like the History rail — a transformed ancestor
 * would otherwise become the containing block for this `fixed` overlay and clip it.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm action as a destructive (red) action. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <motion.div
      className="fixed inset-0 z-[60] grid place-items-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-canvas/60 backdrop-blur-sm" />

      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-hairline bg-surface-raised/95 p-5 shadow-2xl backdrop-blur-xl"
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 6 }}
        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        <div className="mt-2 text-[13px] leading-relaxed text-ink-muted">{message}</div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-hairline px-3.5 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: destructive ? 'rgb(239 68 68)' : 'rgb(var(--c-pulse))' }}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
