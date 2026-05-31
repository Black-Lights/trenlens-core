'use client';

import { motion } from 'framer-motion';
import type { Conversation } from '@/lib/ipc';

/**
 * Left-hand conversation history. A collapsible rail listing every stored
 * session (most-recent first), a "+ New chat" action at the top, and the active
 * session highlighted. Reading/selecting routes through the Rust SQLite store —
 * sessions survive restarts. Token-driven styling, mirrors the right ServerSidebar.
 */
export function HistorySidebar({
  conversations,
  currentId,
  ready,
  onNewChat,
  onSelect,
  onDelete,
  onClose,
}: {
  conversations: Conversation[];
  currentId: string | null;
  ready: boolean | null;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  /** Request deletion — the page shows a styled confirm popup before deleting. */
  onDelete: (conversation: Conversation) => void;
  onClose: () => void;
}) {
  return (
    <motion.aside
      initial={{ x: -28, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -28, opacity: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-hairline/70 bg-surface/50 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-muted">History</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse history"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint transition-colors hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>

      {/* New chat */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          disabled={ready === false}
          className="flex w-full items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-pulse/60 disabled:opacity-30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-ink-faint">
            {ready === false
              ? 'History lives in the local database — launch the desktop app to load past chats.'
              : 'No conversations yet. Start one below and it will be saved here.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const active = c.id === currentId;
              return (
                <li key={c.id} className="group/item relative">
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    title={c.title}
                    className="flex w-full items-center gap-2 rounded-lg border py-2 pl-2.5 pr-9 text-left transition-colors"
                    style={{
                      borderColor: active ? 'rgb(var(--c-pulse) / 0.5)' : 'transparent',
                      background: active ? 'rgb(var(--c-surface-raised) / 0.7)' : 'transparent',
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: active ? 'rgb(var(--c-pulse))' : 'rgb(var(--c-ink-faint))' }}
                    />
                    <span className={`truncate text-[13px] ${active ? 'text-ink' : 'text-ink-muted group-hover/item:text-ink'}`}>
                      {c.title || 'Untitled'}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete "${c.title || 'Untitled'}"`}
                    onClick={() => onDelete(c)}
                    className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-faint transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover/item:grid"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </motion.aside>
  );
}
