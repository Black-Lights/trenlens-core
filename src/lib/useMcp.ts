'use client';

import { desc, eq } from 'drizzle-orm';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineEntry } from '@/components/timeline/types';
import { apiKeys, settings } from '@/db/schema';
import { db } from './db';
import { ipc, isTauri, type Conversation, type McpServerDto, type McpTool, type ProxyStatus, type StoredMessage, type ToolInputSchema } from './ipc';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, modelsFor } from './models';

/** Result of the on-mount Drizzle → Tauri → SQLite pipeline probe. */
export interface DbStatus {
  ok: boolean;
  count?: number;
  error?: string;
}

/**
 * Live state of a BYOK key submission as it flows through the crypto boundary:
 * seal the plaintext (§5) → persist the ciphertext via Drizzle → verify it
 * round-trips back through `unseal_data`. `hint` is a non-secret tail of the key
 * (e.g. `••••3a9f`) so the UI can confirm *which* key sealed without exposing it.
 */
export interface SealStatus {
  state: 'idle' | 'sealing' | 'verified' | 'error';
  provider?: string;
  hint?: string;
  error?: string;
}

/**
 * The live controller that binds the timeline UI to the Rust MCP host.
 *
 * Real IPC, no mocks: `list_mcp_servers` / `list_mcp_tools` populate the panel;
 * `register_mcp_server` brings up a stdio child; `call_mcp_tool` drives a
 * Morphing Node through its lifecycle (spawn → processing while the native call
 * is in flight → dissolving as the payload streams through Typographic Unblur →
 * done / error). There is no LLM in the loop yet, so the composer is a command
 * bar: `server::tool {json}` (or a bare tool name when unambiguous).
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2);

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Flatten an MCP CallToolResult's content blocks into displayable text. */
function renderToolContent(content: unknown): string {
  if (content == null) return '';
  const c = content as { content?: unknown };
  if (Array.isArray(c.content)) {
    return (c.content as Array<Record<string, unknown>>)
      .map((b) => {
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image') return `[image${b.mimeType ? ` ${String(b.mimeType)}` : ''}]`;
        if (b.type === 'resource') {
          const r = b.resource as { uri?: string } | undefined;
          return `[resource ${r?.uri ?? ''}]`;
        }
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

/** Parse the `list_mcp_tools` envelope (`{ tools, errors }`) into McpTool[]. */
function parseTools(content: unknown): McpTool[] {
  const c = content as { tools?: unknown } | null;
  const arr = c && Array.isArray(c.tools) ? (c.tools as Array<Record<string, unknown>>) : [];
  return arr.map((t) => ({
    server: String(t.server ?? ''),
    name: String(t.name ?? ''),
    qualifiedName: String(t.qualifiedName ?? `${String(t.server ?? '')}::${String(t.name ?? '')}`),
    description: typeof t.description === 'string' ? t.description : undefined,
    inputSchema: (t.inputSchema ?? t.input_schema) as ToolInputSchema | undefined,
  }));
}

/** A skeleton args object from a tool's input schema (required fields only). */
export function scaffoldArgs(schema?: ToolInputSchema): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const required = schema?.required ?? Object.keys(props);
  const out: Record<string, unknown> = {};
  for (const key of required) {
    const t = props[key]?.type;
    out[key] =
      t === 'number' || t === 'integer' ? 0 : t === 'boolean' ? false : t === 'array' ? [] : t === 'object' ? {} : '';
  }
  return out;
}

/** Composer seed for a tool: `server::tool {scaffolded json}` (or just the name). */
export function seedFor(tool: McpTool): string {
  const args = scaffoldArgs(tool.inputSchema);
  return Object.keys(args).length ? `${tool.qualifiedName} ${JSON.stringify(args)}` : tool.qualifiedName;
}

function helpText(ref: string, tools: McpTool[]): string {
  if (tools.length === 0) {
    return 'No tools are connected yet. Open the panel (top-right) and register a local MCP server — for example command "npx.cmd" with args "-y @modelcontextprotocol/server-everything".';
  }
  const names = tools.slice(0, 8).map((t) => t.qualifiedName).join(', ');
  return `I couldn't find a tool called "${ref}". Available: ${names}${tools.length > 8 ? ', …' : ''}. Invoke one as server::tool {json args}, or pick it from the panel.`;
}

export interface RegisterInput {
  name: string;
  command: string;
  args: string[];
}

export interface SaveKeyInput {
  provider: string;
  secret: string;
  label?: string;
  baseUrl?: string;
}

/** A non-secret tail of a key for confirmation UI, e.g. `••••3a9f`. */
function keyHint(secret: string): string {
  const tail = secret.slice(-4);
  return `••••${tail}`;
}

/**
 * Replay a persisted message into a timeline entry. user/assistant turns map
 * directly; tool/image turns are stored under role 'tool' with a JSON payload
 * (see `persist`), so we parse that back into the rich entry it came from.
 */
function dbMessageToEntry(m: StoredMessage): TimelineEntry | null {
  if (m.role === 'user') return { id: m.id, kind: 'user', text: m.content };
  if (m.role === 'assistant') return { id: m.id, kind: 'assistant', text: m.content };
  if (m.role === 'tool') {
    try {
      const o = JSON.parse(m.content) as Record<string, unknown>;
      if (o && o.kind === 'image') {
        return {
          id: m.id,
          kind: 'image',
          prompt: String(o.prompt ?? ''),
          stage: 'done',
          route: o.route as string | undefined,
          classification: o.classification as string | undefined,
          expandedPrompt: o.expandedPrompt as string | undefined,
          image: o.image as string | undefined,
          mock: Boolean(o.mock),
          note: o.note as string | undefined,
        };
      }
      if (o && typeof o.tool === 'string') {
        return {
          id: m.id,
          kind: 'tool',
          tool: o.tool,
          server: o.server as string | undefined,
          phase: 'done',
          output: String(o.output ?? ''),
        };
      }
    } catch {
      /* fall through to plain rendering */
    }
    return { id: m.id, kind: 'tool', tool: 'result', phase: 'done', output: m.content };
  }
  return null; // system / unknown roles aren't rendered
}

export function useMcp() {
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null); // null = checking
  const [notice, setNotice] = useState<string | null>(null);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [sealStatus, setSealStatus] = useState<SealStatus>({ state: 'idle' });
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [keyedProviders, setKeyedProviders] = useState<string[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [provider, setProviderState] = useState<string>(DEFAULT_PROVIDER);
  const [model, setModelState] = useState<string>(DEFAULT_MODEL);
  const running = useRef(false);
  // Refs mirror the async-relevant state so stable callbacks read fresh values
  // (the timeline closures don't re-create on every conversation/model change).
  const convIdRef = useRef<string | null>(null);
  const providerRef = useRef<string>(DEFAULT_PROVIDER);
  const modelRef = useRef<string>(DEFAULT_MODEL);

  const patch = useCallback((id: string, next: Record<string, unknown>) => {
    setEntries((es) => es.map((e) => (e.id === id ? ({ ...e, ...next } as TimelineEntry) : e)));
  }, []);
  const append = useCallback((e: TimelineEntry) => setEntries((es) => [...es, e]), []);

  // Word-chunked streaming that feeds the per-character Typographic Unblur.
  // Long payloads are dropped in directly (the node dissolve + container unblur
  // still animate) so we never run a multi-second marathon.
  const stream = useCallback(
    async (id: string, full: string, field: 'text' | 'output') => {
      if (full.length > 1200) {
        patch(id, { [field]: full, streaming: false });
        return;
      }
      const tokens = full.match(/\S+\s*|\s+/g) ?? [full];
      let acc = '';
      for (const tk of tokens) {
        acc += tk;
        patch(id, { [field]: acc, streaming: true });
        await sleep(24);
      }
      patch(id, { [field]: full, streaming: false });
    },
    [patch],
  );

  const assistantSay = useCallback(
    async (text: string) => {
      const id = uid();
      append({ id, kind: 'assistant', text: '', streaming: true });
      await stream(id, text, 'text');
    },
    [append, stream],
  );

  const refresh = useCallback(async () => {
    const [srv, toolRes] = await Promise.all([ipc.listMcpServers(), ipc.listMcpTools()]);
    setServers(srv);
    const parsed = parseTools(toolRes.content);
    setTools(parsed);
    return { servers: srv, tools: parsed };
  }, []);

  // Which providers have a real sealed key stored (so the UI can show what's
  // available to chat). Excludes the pipeline `probe` row and the `pending-crypto`
  // placeholder, so Anthropic isn't falsely flagged before a real key is added.
  const loadKeyStatus = useCallback(async () => {
    try {
      const rows = await db.select().from(apiKeys);
      const real = rows.filter(
        (r) => r.id !== 'probe' && !!r.secretCiphertext && r.secretCiphertext !== 'pending-crypto',
      );
      setKeyedProviders([...new Set(real.map((r) => r.provider))]);
      setDbStatus({ ok: true, count: real.length });
    } catch (e) {
      setDbStatus({ ok: false, error: errMsg(e) });
    }
  }, []);

  // ── Conversation history ───────────────────────────────────────────────────

  const refreshConversations = useCallback(async () => {
    if (ready === false) return;
    try {
      setConversations(await ipc.listConversations());
    } catch (e) {
      setNotice(errMsg(e));
    }
  }, [ready]);

  // Persist one turn under the active session (best-effort). user/assistant chat
  // turns are persisted backend-side; this handles the tool/image turns, which we
  // stash as a JSON payload under role 'tool' so they replay faithfully on reload.
  const persist = useCallback(
    async (role: string, content: string) => {
      const cid = convIdRef.current;
      if (!cid || ready === false) return;
      try {
        await ipc.appendMessage(cid, role, content);
      } catch {
        /* a storage hiccup must not break the live turn */
      }
    },
    [ready],
  );

  // Lazily create a session row the first time a turn is sent into a fresh view.
  const ensureConversation = useCallback(
    async (firstText: string): Promise<string | null> => {
      if (ready === false) return null;
      if (convIdRef.current) return convIdRef.current;
      try {
        const convo = await ipc.createConversation(firstText || 'New chat');
        convIdRef.current = convo.id;
        setCurrentConversationId(convo.id);
        setConversations((cs) => [convo, ...cs]);
        return convo.id;
      } catch (e) {
        setNotice(errMsg(e));
        return null;
      }
    },
    [ready],
  );

  // "+ New chat": clear the timeline and start a fresh session in the DB. Reuses
  // an already-empty session so repeated clicks don't stack empty rows.
  const newChat = useCallback(async () => {
    if (running.current) return;
    if (entries.length === 0 && convIdRef.current) return;
    setEntries([]);
    convIdRef.current = null;
    setCurrentConversationId(null);
    if (ready === false) return;
    try {
      const convo = await ipc.createConversation('New chat');
      convIdRef.current = convo.id;
      setCurrentConversationId(convo.id);
      setConversations((cs) => [convo, ...cs]);
    } catch (e) {
      setNotice(errMsg(e));
    }
  }, [entries.length, ready]);

  // Reopen an old session: pull its messages and replay them onto the timeline.
  const loadConversation = useCallback(
    async (id: string) => {
      if (running.current || ready === false || id === convIdRef.current) return;
      try {
        const msgs = await ipc.listMessages(id);
        const replayed = msgs
          .map(dbMessageToEntry)
          .filter((e): e is TimelineEntry => e !== null);
        setEntries(replayed);
        convIdRef.current = id;
        setCurrentConversationId(id);
      } catch (e) {
        setNotice(errMsg(e));
      }
    },
    [ready],
  );

  // ── Active chat provider / model (persisted to the settings table) ──────────

  const persistChatConfig = useCallback(
    async (p: string, m: string) => {
      if (ready === false) return;
      try {
        await db
          .insert(settings)
          .values({ key: 'chat.config', value: { provider: p, model: m } })
          .onConflictDoUpdate({ target: settings.key, set: { value: { provider: p, model: m } } });
      } catch {
        /* preference persistence is best-effort */
      }
    },
    [ready],
  );

  // Switching provider resets the model to that provider's first chat model.
  const setActiveProvider = useCallback(
    (p: string) => {
      const first = modelsFor(p)[0]?.id ?? '';
      providerRef.current = p;
      modelRef.current = first;
      setProviderState(p);
      setModelState(first);
      void persistChatConfig(p, first);
    },
    [persistChatConfig],
  );

  const setActiveModel = useCallback(
    (m: string) => {
      modelRef.current = m;
      setModelState(m);
      void persistChatConfig(providerRef.current, m);
    },
    [persistChatConfig],
  );

  // Bind a real tool execution to the Morphing Node lifecycle.
  const runTool = useCallback(
    async (server: string, tool: string, args: unknown) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      const id = uid();
      append({ id, kind: 'tool', tool, server, phase: 'spawn' });
      await sleep(160);
      patch(id, { phase: 'processing' }); // breathes + orbits while the native call is in flight
      try {
        const res = await ipc.callMcpTool(server, tool, args ?? {});
        const text = renderToolContent(res.content);
        if (res.ok) {
          patch(id, { phase: 'dissolving' });
          await stream(id, text || '(tool returned no content)', 'output');
          patch(id, { phase: 'done' });
          await persist('tool', JSON.stringify({ tool, server, output: text || '(tool returned no content)' }));
        } else {
          patch(id, { phase: 'error', output: text || 'The tool reported an error.', streaming: false });
        }
      } catch (e) {
        patch(id, { phase: 'error', output: errMsg(e), streaming: false });
      } finally {
        setBusy(false);
        running.current = false;
      }
    },
    [append, patch, persist, stream],
  );

  // Two-stage image pipeline (§7). The backend resolves both stages in one call,
  // so we choreograph the visible "Expanding prompt…" → "Rendering image…"
  // transition here (min-visible windows) while the Morphing Node breathes. The
  // final render arrives as a data-URI / URL and reveals via Typographic Unblur.
  const generateImage = useCallback(
    async (prompt: string, forceRoute?: string) => {
      const p = prompt.trim();
      if (!p || running.current) return;
      running.current = true;
      setBusy(true);
      const id = uid();
      append({ id, kind: 'image', prompt: p, stage: 'expanding' });
      try {
        const call = ipc.generateImage(p, forceRoute);
        await sleep(700); // let Stage 1 register visually
        patch(id, { stage: 'rendering' });
        const res = await call;
        await sleep(420); // let Stage 2 register before the reveal
        patch(id, {
          stage: 'done',
          route: res.route,
          classification: res.classification,
          expandedPrompt: res.expandedPrompt,
          image: res.image,
          mock: res.mock,
          note: res.note ?? undefined,
        });
        await persist(
          'tool',
          JSON.stringify({
            kind: 'image',
            prompt: p,
            route: res.route,
            classification: res.classification,
            expandedPrompt: res.expandedPrompt,
            image: res.image,
            mock: res.mock,
            note: res.note ?? undefined,
          }),
        );
      } catch (e) {
        patch(id, { stage: 'error', error: errMsg(e) });
      } finally {
        setBusy(false);
        running.current = false;
      }
    },
    [append, patch, persist],
  );

  // Conversational orchestrator (direct Anthropic loop). Plain-English turns land
  // here: the assistant node breathes ("thinking") while the backend runs the
  // tool_use loop against the connected MCP tools, then the final answer streams in
  // via Typographic Unblur. The anthropic key is unsealed backend-side — plaintext
  // never reaches the webview. Tools the model invoked are noted under the answer.
  const chat = useCallback(
    async (prompt: string) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      const id = uid();
      append({ id, kind: 'assistant', text: '', thinking: true });
      try {
        const res = await ipc.submitChatMessage(prompt, {
          provider: providerRef.current,
          model: modelRef.current,
          sessionId: convIdRef.current,
        });
        patch(id, { thinking: false, toolsUsed: res.toolsUsed?.length ? res.toolsUsed : undefined });
        await stream(id, res.text || '(no response)', 'text');
        // The backend persists the user + assistant turns under sessionId.
      } catch (e) {
        patch(id, { thinking: false, error: true, streaming: false, text: errMsg(e) });
      } finally {
        setBusy(false);
        running.current = false;
      }
    },
    [append, patch, stream],
  );

  const resolveTool = useCallback(
    (ref: string): McpTool | 'ambiguous' | null => {
      if (ref.includes('::')) return tools.find((t) => t.qualifiedName === ref) ?? null;
      const matches = tools.filter((t) => t.name === ref);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return 'ambiguous';
      return null;
    },
    [tools],
  );

  // Parse a composer line and route it to a real tool call (or an explainer).
  const dispatch = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || running.current) return;
      append({ id: uid(), kind: 'user', text });

      if (ready === false) {
        await assistantSay(
          "The native backend isn't available in this browser preview, so I can't reach any MCP servers. Launch the desktop app (tauri dev) to orchestrate tools.",
        );
        return;
      }

      // Make sure a session exists, then route. Afterwards the conversation list
      // is refreshed so titles (incl. the LLM auto-name) and ordering update.
      await ensureConversation(text);
      try {
        // `/image <prompt>` (or `/imagine`) triggers the two-stage image pipeline.
        // An optional route hint forces Stage 2: `/image:flux …` or `/image:ideogram …`.
        const img = /^\/(?:image|imagine)(?::(\w+))?\s+([\s\S]+)$/i.exec(text);
        if (img) {
          await persist('user', text);
          await generateImage(img[2].trim(), img[1]?.toLowerCase());
          return;
        }

        const m = /^(\S+)([\s\S]*)$/.exec(text);
        const ref = m?.[1] ?? text;
        const restRaw = (m?.[2] ?? '').trim();

        // Explicit `server::tool {json}` invocations bypass the LLM and run directly
        // (this is also exactly what the tool palette seeds). Everything else is
        // treated as natural language and handed to the conversational orchestrator.
        if (ref.includes('::')) {
          const resolved = resolveTool(ref);
          if (!resolved || resolved === 'ambiguous') {
            await assistantSay(helpText(ref, tools));
            return;
          }
          let args: unknown = {};
          if (restRaw) {
            try {
              args = JSON.parse(restRaw);
            } catch {
              await assistantSay(`I couldn't parse those arguments as JSON: ${restRaw}`);
              return;
            }
          }
          await persist('user', text);
          await runTool(resolved.server, resolved.name, args);
          return;
        }

        // Plain English → the active provider/model, MCP tools injected (agentic
        // loop). The backend persists both turns + auto-names the session.
        await chat(text);
      } finally {
        void refreshConversations();
      }
    },
    [append, assistantSay, chat, ensureConversation, generateImage, persist, ready, refreshConversations, resolveTool, runTool, tools],
  );

  const registerServer = useCallback(
    async (input: RegisterInput) => {
      const dto: McpServerDto = {
        id: uid(),
        name: input.name.trim() || input.command,
        transport: 'stdio',
        command: input.command,
        args: input.args,
        url: null,
      };
      try {
        await ipc.registerMcpServer(dto);
        const { tools: t } = await refresh();
        const count = t.filter((x) => x.server === dto.id).length;
        await assistantSay(`Connected ${dto.name} over stdio — ${count} tool${count === 1 ? '' : 's'} available.`);
        return true;
      } catch (e) {
        await assistantSay(`Couldn't connect ${dto.name}: ${errMsg(e)}`);
        return false;
      }
    },
    [refresh, assistantSay],
  );

  // BYOK: seal a provider key (§5), persist only the ciphertext via Drizzle, and
  // prove it round-trips. The plaintext lives only in this closure — it's never
  // stored, logged, or returned; the UI sees a non-secret `hint` and a verdict.
  const saveApiKey = useCallback(
    async (input: SaveKeyInput): Promise<boolean> => {
      const secret = input.secret.trim();
      const provider = input.provider.trim() || 'custom';
      if (!secret) return false;
      if (ready === false) {
        setSealStatus({ state: 'error', provider, error: 'Backend offline — launch the desktop app.' });
        return false;
      }

      setSealStatus({ state: 'sealing', provider, hint: keyHint(secret) });
      try {
        // 1) Seal through the Rust crypto boundary (master key stays in keychain).
        const ciphertext = await ipc.sealData(secret);
        // 2) Verify the sealed blob round-trips before we trust/persist it.
        const roundTrip = await ipc.unsealData(ciphertext);
        const verified = roundTrip === secret;

        // 3) Persist ciphertext ONLY — plaintext never reaches the DB.
        await db.insert(apiKeys).values({
          id: uid(),
          provider,
          label: input.label?.trim() || provider,
          baseUrl: input.baseUrl?.trim() || null,
          secretCiphertext: ciphertext,
        });
        // Recompute which providers are keyed so the availability UI updates.
        await loadKeyStatus();

        setSealStatus(
          verified
            ? { state: 'verified', provider, hint: keyHint(secret) }
            : { state: 'error', provider, error: 'Round-trip mismatch — key not verified.' },
        );
        return verified;
      } catch (e) {
        setSealStatus({ state: 'error', provider, error: errMsg(e) });
        return false;
      }
    },
    [ready, loadKeyStatus],
  );

  // Start the local BYOK proxy for `provider`: look up that provider's SEALED key
  // in Drizzle and hand the ciphertext to the backend, which unseals it in-process
  // and injects it into the sidecar's env. Plaintext never reaches the webview.
  const startProxy = useCallback(async (provider: string): Promise<ProxyStatus | null> => {
    if (ready === false) return null;
    try {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.provider, provider))
        .orderBy(desc(apiKeys.createdAt))
        .limit(1);
      const ciphertext = rows[0]?.secretCiphertext ?? null;
      const status = await ipc.startByokProxy({ provider, ciphertext });
      setProxyStatus(status);
      // The bind line arrives just after spawn; re-poll once so the UI shows the URL.
      setTimeout(() => {
        void ipc.getProxyStatus().then(setProxyStatus).catch(() => {});
      }, 400);
      return status;
    } catch (e) {
      setProxyStatus({ running: false, provider, message: errMsg(e) });
      return null;
    }
  }, [ready]);

  const stopProxy = useCallback(async (): Promise<void> => {
    if (ready === false) return;
    try {
      setProxyStatus(await ipc.stopByokProxy());
    } catch (e) {
      setProxyStatus((s) => ({ ...(s ?? { running: false }), message: errMsg(e) }));
    }
  }, [ready]);

  // Initial load: detect the runtime, then pull servers + tools.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isTauri()) {
        if (alive) setReady(false);
        return;
      }
      if (alive) setReady(true);
      try {
        await refresh();
      } catch (e) {
        if (alive) setNotice(errMsg(e));
      }

      // Prove the Drizzle → Tauri → SQLite pipeline (idempotent probe write), then
      // load which providers are keyed (the probe itself is excluded from that).
      try {
        await db
          .insert(apiKeys)
          .values({ id: 'probe', provider: 'anthropic', label: 'probe', secretCiphertext: 'pending-crypto' })
          .onConflictDoNothing();
        if (alive) await loadKeyStatus();
      } catch (e) {
        if (alive) setDbStatus({ ok: false, error: errMsg(e) });
      }

      // Reflect any already-running proxy (e.g. after a webview reload).
      try {
        const ps = await ipc.getProxyStatus();
        if (alive) setProxyStatus(ps);
      } catch {
        /* proxy status is best-effort */
      }

      // Restore the persisted chat provider/model preference, snapping a stale
      // model id (e.g. an older model that's since been removed) to the provider's
      // current first model so the dropdown never shows an orphaned value.
      try {
        const cfgRows = await db.select().from(settings).where(eq(settings.key, 'chat.config'));
        const cfg = cfgRows[0]?.value as { provider?: string; model?: string } | undefined;
        if (cfg && alive) {
          const p = cfg.provider || DEFAULT_PROVIDER;
          const valid = modelsFor(p).some((m) => m.id === cfg.model);
          const mdl = valid ? (cfg.model as string) : (modelsFor(p)[0]?.id ?? '');
          providerRef.current = p;
          modelRef.current = mdl;
          setProviderState(p);
          setModelState(mdl);
        }
      } catch {
        /* no saved preference yet */
      }

      // List existing conversation sessions for the history sidebar.
      try {
        const convos = await ipc.listConversations();
        if (alive) setConversations(convos);
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh, loadKeyStatus]);

  return {
    servers,
    tools,
    entries,
    busy,
    ready,
    notice,
    dbStatus,
    sealStatus,
    proxyStatus,
    keyedProviders,
    conversations,
    currentConversationId,
    provider,
    model,
    dispatch,
    registerServer,
    saveApiKey,
    startProxy,
    stopProxy,
    generateImage,
    chat,
    runTool,
    refresh,
    newChat,
    loadConversation,
    setActiveProvider,
    setActiveModel,
  };
}
