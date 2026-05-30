'use client';

import { motion } from 'framer-motion';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export interface Connection {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  live: boolean;
}

/**
 * Top rail: a draggable Tauri title strip, the live MCP connections (each a
 * breathing pulse dot whose glow = an active link), a config toggle, and the
 * theme toggle.
 */
export function ConnectionBar({
  connections,
  onToggleConfig,
  configOpen = false,
  onToggleHistory,
  historyOpen = false,
}: {
  connections: Connection[];
  onToggleConfig?: () => void;
  configOpen?: boolean;
  onToggleHistory?: () => void;
  historyOpen?: boolean;
}) {
  return (
    <header
      data-tauri-drag-region
      className="flex items-center justify-between border-b border-hairline/60 bg-surface/40 px-5 py-3 backdrop-blur-xl"
    >
      <div className="flex items-center gap-3">
        {onToggleHistory && (
          <button
            type="button"
            onClick={onToggleHistory}
            aria-label="Toggle chat history"
            aria-pressed={historyOpen}
            className="grid h-8 w-8 place-items-center rounded-lg border text-ink-muted transition-colors hover:text-ink"
            style={{ borderColor: historyOpen ? 'rgb(var(--c-pulse) / 0.6)' : 'rgb(var(--c-hairline))' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
        )}
        <span className="text-[13px] font-semibold tracking-tight text-ink">TrenLens<span className="text-pulse"> Core</span></span>
        <span className="h-3 w-px bg-hairline" />
        {connections.length === 0 ? (
          <span className="text-[11px] text-ink-faint">no servers connected</span>
        ) : (
          <ul className="flex items-center gap-3">
            {connections.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5" title={`${c.name} · ${c.transport}${c.live ? ' · live' : ' · offline'}`}>
                <span className="relative grid place-items-center">
                  {c.live && (
                    <motion.span
                      className="absolute h-2.5 w-2.5 rounded-full"
                      style={{ background: 'rgb(var(--c-pulse))' }}
                      animate={{ opacity: [0.5, 0, 0.5], scale: [1, 2.2, 1] }}
                      transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                    />
                  )}
                  <span
                    className="relative h-1.5 w-1.5 rounded-full"
                    style={{ background: c.live ? 'rgb(var(--c-pulse))' : 'rgb(var(--c-ink-faint))' }}
                  />
                </span>
                <span className="text-[11px] text-ink-muted">{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {onToggleConfig && (
          <button
            type="button"
            onClick={onToggleConfig}
            aria-label="Toggle servers panel"
            aria-pressed={configOpen}
            className="grid h-8 w-8 place-items-center rounded-lg border text-ink-muted transition-colors hover:text-ink"
            style={{ borderColor: configOpen ? 'rgb(var(--c-pulse) / 0.6)' : 'rgb(var(--c-hairline))' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
