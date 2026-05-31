'use client';

import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import {
  APP_CHANNEL,
  APP_NAME,
  APP_TAGLINE,
  APP_VERSION,
  BUILT_WITH,
  DEVELOPER,
  LICENSE,
  REPO_URL,
} from '@/lib/appInfo';
import { ipc } from '@/lib/ipc';
import { checkForUpdate, type UpdateInfo } from '@/lib/updates';

/**
 * About dialog — app/version/developer details, a "Download for Windows" action
 * that opens the latest GitHub release (where the installer/.exe lives), and the
 * honest alpha disclaimer. Token-driven styling; closes on backdrop click or Esc.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setUpdate(await checkForUpdate());
    setChecking(false);
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-canvas/60 backdrop-blur-sm" />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="About TrenLens Core"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-hairline bg-surface-raised/95 p-6 shadow-2xl backdrop-blur-xl"
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 6 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-ink-faint transition-colors hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Logo + name + version */}
        <div className="flex items-center gap-3">
          <span className="relative grid h-11 w-11 place-items-center">
            <span
              className="absolute h-11 w-11 animate-breathe rounded-full"
              style={{ background: 'radial-gradient(circle, rgb(var(--c-pulse)/0.35), transparent 70%)' }}
            />
            <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: 'rgb(var(--c-pulse))' }} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[17px] font-semibold tracking-tight text-ink">{APP_NAME}</h2>
              <span className="rounded-full border border-pulse/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-pulse">
                {APP_CHANNEL}
              </span>
            </div>
            <p className="font-mono text-[11px] text-ink-faint">v{APP_VERSION}</p>
          </div>
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">{APP_TAGLINE}</p>

        {/* Updates */}
        <div className="mt-4">
          {update?.status === 'available' ? (
            <button
              type="button"
              onClick={() => update.url && void ipc.openExternal(update.url)}
              className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90"
              style={{ background: 'rgb(var(--c-pulse))' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              Download v{update.latest}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void check()}
              disabled={checking}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-hairline py-2.5 text-[13px] font-medium text-ink transition-colors hover:border-pulse/60 disabled:opacity-50"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={checking ? 'animate-spin' : ''}
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}

          {update && (
            <p className="mt-1.5 text-center text-[11px]">
              {update.status === 'latest' && (
                <span className="text-ink-faint">You&apos;re on the latest version (v{update.latest}).</span>
              )}
              {update.status === 'available' && (
                <span className="text-pulse">Update available — you have v{update.current}.</span>
              )}
              {update.status === 'error' && (
                <span className="text-ink-faint">Couldn&apos;t check for updates: {update.error}</span>
              )}
            </p>
          )}
        </div>

        {/* Details */}
        <dl className="mt-4 space-y-2.5 border-t border-hairline/60 pt-4 text-[12px]">
          <Row label="Developer">
            <Ext href={DEVELOPER.github} className="text-pulse hover:underline">
              {DEVELOPER.name} (@{DEVELOPER.handle})
            </Ext>
          </Row>
          <Row label="Repository">
            <Ext href={REPO_URL} className="break-all text-pulse hover:underline">
              {REPO_URL.replace('https://', '')}
            </Ext>
          </Row>
          <Row label="Contact">
            <Ext href={`mailto:${DEVELOPER.email}`} className="break-all text-ink-muted hover:text-ink">
              {DEVELOPER.email}
            </Ext>
          </Row>
          <Row label="License">
            <span className="text-ink">{LICENSE}</span>
          </Row>
        </dl>

        {/* Built with */}
        <div className="mt-4">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Built with</div>
          <div className="flex flex-wrap gap-1.5">
            {BUILT_WITH.map((b) => (
              <span key={b} className="rounded-full border border-hairline bg-surface px-2 py-0.5 text-[11px] text-ink-muted">
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* Honest alpha disclaimer */}
        <p className="mt-5 rounded-lg border border-hairline/70 bg-surface/60 px-3 py-2 text-[11px] leading-relaxed text-ink-faint">
          Early <span className="text-ink-muted">alpha</span> — features may change or break. Provider keys are
          sealed locally (AES-256-GCM, OS keychain); chat history is stored unencrypted on this device. Don&apos;t
          use it for production secrets yet.
        </p>
      </motion.div>
    </motion.div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** External link that opens in the system browser via the opener plugin. */
function Ext({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void ipc.openExternal(href);
      }}
      className={className}
    >
      {children}
    </a>
  );
}
