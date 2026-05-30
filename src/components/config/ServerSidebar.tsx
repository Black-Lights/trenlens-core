'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import type { McpServerDto, McpTool, ProxyStatus } from '@/lib/ipc';
import { costFor, modelsFor, PROVIDERS } from '@/lib/models';
import type { DbStatus, RegisterInput, SaveKeyInput, SealStatus } from '@/lib/useMcp';

/**
 * Config panel: register a local stdio MCP server on the fly, see the live
 * connections, and pick a tool to prefill the composer. Token-driven styling
 * only — it slides in beside the timeline, never over the composer.
 */
export function ServerSidebar({
  servers,
  tools,
  ready,
  dbStatus,
  sealStatus,
  proxyStatus,
  keyedProviders,
  provider,
  model,
  onProviderChange,
  onModelChange,
  onRegister,
  onSaveKey,
  onStartProxy,
  onStopProxy,
  onPickTool,
  onClose,
}: {
  servers: McpServerDto[];
  tools: McpTool[];
  ready: boolean | null;
  dbStatus?: DbStatus | null;
  sealStatus?: SealStatus;
  proxyStatus?: ProxyStatus | null;
  /** Provider ids that currently have a real sealed key stored. */
  keyedProviders: string[];
  /** Active chat provider (also the provider a BYOK key is stored under). */
  provider: string;
  /** Active chat model id (empty for non-chat providers). */
  model: string;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string) => void;
  onRegister: (input: RegisterInput) => Promise<boolean>;
  onSaveKey: (input: SaveKeyInput) => Promise<boolean>;
  onStartProxy: (provider: string) => Promise<ProxyStatus | null>;
  onStopProxy: () => Promise<void>;
  onPickTool: (tool: McpTool) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('npx.cmd');
  const [argsText, setArgsText] = useState('-y @modelcontextprotocol/server-everything');
  const [submitting, setSubmitting] = useState(false);

  const [secret, setSecret] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);

  const models = modelsFor(provider);
  const selectedCost = costFor(provider, model);
  const hasKey = (id: string) => keyedProviders.includes(id);

  const proxyRunning = proxyStatus?.running ?? false;

  const inputCls =
    'w-full rounded-lg border border-hairline bg-surface-raised/60 px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-pulse/60';

  const liveOf = (id: string) => tools.some((t) => t.server === id);

  const submit = async () => {
    const cmd = command.trim();
    if (!cmd || submitting || ready === false) return;
    setSubmitting(true);
    const ok = await onRegister({
      name: name.trim(),
      command: cmd,
      args: argsText.trim().split(/\s+/).filter(Boolean),
    });
    setSubmitting(false);
    if (ok) setName('');
  };

  const saveKey = async () => {
    const s = secret.trim();
    if (!s || savingKey || ready === false) return;
    setSavingKey(true);
    const ok = await onSaveKey({ provider, secret: s });
    setSavingKey(false);
    if (ok) setSecret(''); // discard plaintext the moment it's sealed + verified
  };

  const toggleProxy = async () => {
    if (proxyBusy || ready === false) return;
    setProxyBusy(true);
    if (proxyRunning) await onStopProxy();
    else await onStartProxy(provider);
    setProxyBusy(false);
  };

  return (
    <motion.aside
      initial={{ x: 28, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 28, opacity: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-full w-[324px] shrink-0 flex-col overflow-y-auto border-l border-hairline/70 bg-surface/50 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-muted">Servers</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-faint transition-colors hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ── Register a local stdio server ── */}
      <section className="border-t border-hairline/60 px-4 py-4">
        <h3 className="mb-2.5 text-[13px] font-medium text-ink">Add a local server</h3>
        <div className="space-y-2">
          <Field label="Name (optional)">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="everything"
              className={inputCls}
            />
          </Field>
          <Field label="Command">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              spellCheck={false}
              placeholder="npx.cmd"
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="Arguments">
            <input
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="-y @modelcontextprotocol/server-everything"
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!command.trim() || submitting || ready === false}
          className="mt-3 w-full rounded-lg py-2 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-30"
          style={{ background: 'rgb(var(--c-pulse))' }}
        >
          {submitting ? 'Connecting…' : 'Connect (stdio)'}
        </button>

        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          On Windows, npm-based servers must use the <span className="font-mono text-ink-muted">.cmd</span> shim
          (e.g. <span className="font-mono text-ink-muted">npx.cmd</span>) — see §11.
          {ready === false && (
            <span className="mt-1 block text-pulse">Backend offline — launch the desktop app to connect.</span>
          )}
        </p>
      </section>

      {/* ── BYOK: seal a provider key (AES-256-GCM, §5) ── */}
      <section className="border-t border-hairline/60 px-4 py-4">
        <h3 className="mb-2 text-[13px] font-medium text-ink">Provider key (BYOK)</h3>

        {/* At-a-glance: which chat LLMs have a key sealed (i.e. are ready to use). */}
        <div className="mb-3 rounded-lg border border-hairline/70 bg-surface-raised/40 px-2.5 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Available to chat</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {PROVIDERS.filter((p) => p.chat).map((p) => {
              const keyed = hasKey(p.id);
              return (
                <span key={p.id} className="flex items-center gap-1.5 text-[11px]" title={keyed ? 'Key sealed — ready' : 'No key yet'}>
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: keyed ? 'rgb(var(--c-pulse))' : 'rgb(var(--c-ink-faint))' }}
                  />
                  <span className={keyed ? 'text-ink' : 'text-ink-faint'}>{p.label}</span>
                </span>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <Field label="Provider">
            <select
              value={provider}
              onChange={(e) => onProviderChange(e.target.value)}
              className={inputCls}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.chat ? '' : ' (key only)'}
                  {hasKey(p.id) ? ' ✓ key sealed' : ' — no key'}
                </option>
              ))}
            </select>
          </Field>

          {/* Model picker — dynamic per provider, with relative cost badges. */}
          {models.length > 0 ? (
            <Field label="Model">
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                className={inputCls}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.cost}
                  </option>
                ))}
              </select>
              {selectedCost && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="rounded-full border border-pulse/40 bg-surface-raised/60 px-2 py-0.5 font-mono text-[10px] text-pulse">
                    {selectedCost} cost
                  </span>
                  <span className="text-[10px] text-ink-faint">relative to Sonnet (1×)</span>
                </div>
              )}
            </Field>
          ) : (
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Chat models are available for <span className="text-ink-muted">Anthropic</span>,{' '}
              <span className="text-ink-muted">DeepSeek</span>, and <span className="text-ink-muted">Kimi</span>.
              This provider is for storing a key only.
            </p>
          )}

          <Field label="API key">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveKey();
                }
              }}
              placeholder="sk-…"
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => void saveKey()}
          disabled={!secret.trim() || savingKey || ready === false}
          className="mt-3 w-full rounded-lg border border-hairline py-2 text-[13px] font-medium text-ink transition-colors hover:border-pulse/60 disabled:opacity-30"
        >
          {savingKey ? 'Sealing…' : 'Seal & save'}
        </button>

        <SealIndicator status={sealStatus} />

        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Sealed with AES-256-GCM before it touches disk; the master key lives in your OS keychain
          and never crosses to the UI (§5).
        </p>
      </section>

      {/* ── Local BYOK proxy (LiteLLM sidecar, §6) ── */}
      <section className="border-t border-hairline/60 px-4 py-4">
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-[13px] font-medium text-ink">BYOK proxy</h3>
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: proxyRunning ? 'rgb(var(--c-pulse))' : 'rgb(var(--c-ink-faint))' }}
            />
            {proxyRunning ? 'running' : 'stopped'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => void toggleProxy()}
          disabled={proxyBusy || ready === false}
          className="w-full rounded-lg border border-hairline py-2 text-[13px] font-medium text-ink transition-colors hover:border-pulse/60 disabled:opacity-30"
        >
          {proxyBusy
            ? proxyRunning
              ? 'Stopping…'
              : 'Starting…'
            : proxyRunning
              ? 'Stop proxy'
              : `Start proxy · ${provider}`}
        </button>

        {proxyRunning && proxyStatus?.url && (
          <div className="mt-3 rounded-lg border border-hairline/70 bg-surface-raised/50 p-2.5">
            <p className="text-[11px] text-ink-muted">Point external tools (e.g. Claude Code) at:</p>
            <div className="mt-1 flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-surface/70 px-1.5 py-1 font-mono text-[12px] text-pulse">
                {proxyStatus.url}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(proxyStatus?.url ?? '')}
                title="Copy URL"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:text-ink"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              Set the tool&apos;s base URL to this address; requests route through LiteLLM with your sealed{' '}
              <span className="text-ink-muted">{proxyStatus.provider ?? provider}</span> key (§6).
            </p>
          </div>
        )}

        {proxyStatus?.message && !proxyRunning && (
          <p className="mt-2 break-words font-mono text-[10px] text-ink-faint">{proxyStatus.message}</p>
        )}
      </section>

      {/* ── Connected servers ── */}
      <section className="border-t border-hairline/60 px-4 py-4">
        <h3 className="mb-2.5 text-[13px] font-medium text-ink">
          Connected <span className="text-ink-faint">({servers.length})</span>
        </h3>
        {servers.length === 0 ? (
          <p className="text-[12px] text-ink-faint">Nothing connected yet.</p>
        ) : (
          <ul className="space-y-2">
            {servers.map((s) => (
              <li key={s.id} className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: liveOf(s.id) ? 'rgb(var(--c-pulse))' : 'rgb(var(--c-ink-faint))' }}
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-ink">{s.name}</div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ') : s.url}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Tool palette ── */}
      <section className="border-t border-hairline/60 px-4 py-4">
        <h3 className="mb-2.5 text-[13px] font-medium text-ink">
          Tools <span className="text-ink-faint">({tools.length})</span>
        </h3>
        {tools.length === 0 ? (
          <p className="text-[12px] text-ink-faint">Connect a server to discover its tools.</p>
        ) : (
          <ul className="space-y-1">
            {tools.map((t) => (
              <li key={t.qualifiedName}>
                <button
                  type="button"
                  onClick={() => onPickTool(t)}
                  title="Prefill the composer with this tool"
                  className="group w-full rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-hairline hover:bg-surface-raised/60"
                >
                  <div className="font-mono text-[12px] text-pulse">{t.qualifiedName}</div>
                  {t.description && (
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-faint">{t.description}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Local store (Drizzle → Tauri → SQLite pipeline status) ── */}
      {dbStatus && (
        <section className="mt-auto border-t border-hairline/60 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[11px]">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: dbStatus.ok ? 'rgb(var(--c-pulse))' : 'rgb(220 90 90)' }}
            />
            <span className="text-ink-muted">
              Local store
              {dbStatus.ok ? ` · ${dbStatus.count} key${dbStatus.count === 1 ? '' : 's'}` : ' · error'}
            </span>
          </div>
          {!dbStatus.ok && dbStatus.error && (
            <p className="mt-1 break-words font-mono text-[10px] text-ink-faint">{dbStatus.error}</p>
          )}
        </section>
      )}
    </motion.aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * The seal round-trip micro-interaction. Confirms a key was sealed AND that its
 * ciphertext unsealed back to the original — surfacing only a masked `••••tail`
 * hint, never the raw key. A drawn check stroke animates in on success.
 */
function SealIndicator({ status }: { status?: SealStatus }) {
  if (!status || status.state === 'idle') return null;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={status.state + (status.hint ?? '') + (status.error ?? '')}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="mt-2.5 flex items-center gap-2 text-[12px]"
      >
        {status.state === 'sealing' && (
          <>
            <motion.span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: 'rgb(var(--c-pulse))' }}
              animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            />
            <span className="text-ink-muted">Sealing &amp; verifying…</span>
          </>
        )}

        {status.state === 'verified' && (
          <>
            <motion.svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgb(var(--c-pulse))"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ scale: 0.6 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 520, damping: 18 }}
            >
              <motion.path
                d="M4 12.5 9.5 18 20 6.5"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.34, ease: 'easeOut' }}
              />
            </motion.svg>
            <span className="text-ink">
              Sealed &amp; verified
              {status.hint && <span className="ml-1 font-mono text-ink-muted">{status.hint}</span>}
            </span>
          </>
        )}

        {status.state === 'error' && (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'rgb(220 90 90)' }} />
            <span className="break-words text-ink-muted">{status.error ?? 'Sealing failed.'}</span>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
