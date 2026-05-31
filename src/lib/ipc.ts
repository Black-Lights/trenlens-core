/**
 * Typed bridge to the Rust backend.
 *
 * Every privileged action crosses exactly one boundary: `window.__TAURI__.invoke`
 * (enabled by `withGlobalTauri: true`). We read the global rather than importing
 * `@tauri-apps/api` so the same bundle also runs in a plain browser during
 * `next dev` (where `invoke` is undefined and we fall back to mock data).
 *
 * The command names and DTO shapes mirror src-tauri/src/commands.rs exactly.
 */

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function getInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (window as any).__TAURI__;
  return tauri?.invoke ?? tauri?.core?.invoke ?? null;
}

/** True when running inside the Tauri webview (vs. a plain browser dev server). */
export const isTauri = (): boolean => getInvoke() !== null;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error(`[ipc] "${cmd}" called outside Tauri (no __TAURI__.invoke)`);
  }
  return invoke<T>(cmd, args);
}

export interface Conversation {
  id: string;
  title: string;
}
/** One persisted timeline turn (mirrors `commands::StoredMessage`). */
export interface StoredMessage {
  id: string;
  role: string; // 'user' | 'assistant' | 'tool' | 'system'
  content: string;
}
/** A user-attached image: `data` is base64 (no prefix); `dataUrl` is for preview. */
export interface ImageAttachment {
  dataUrl: string;
  mediaType: string;
  data: string;
}

/** Active chat config sent with each turn (selected in the BYOK panel). */
export interface ChatOptions {
  provider?: string;
  model?: string;
  sessionId?: string | null;
  images?: { mediaType: string; data: string }[];
}
export interface McpServerDto {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string | null;
  /** Argv for stdio transport, e.g. ['-y', '@modelcontextprotocol/server-everything']. */
  args?: string[] | null;
  url?: string | null;
}
export interface ToolResult {
  ok: boolean;
  content: unknown;
}

/** A JSON-Schema-ish description of a tool's arguments (subset we use). */
export interface ToolInputSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
}

/**
 * One tool from the aggregated `list_mcp_tools` registry. `name` is the bare
 * name to pass to `call_mcp_tool`; `qualifiedName` is `server::name` (collision-
 * safe display); `server` is the owning server id.
 */
export interface McpTool {
  server: string;
  name: string;
  qualifiedName: string;
  description?: string;
  inputSchema?: ToolInputSchema;
}

/** Where the local axum MCP host is reachable (for cooperating web apps). */
export interface HostInfo {
  port: number;
  mcpUrl: string;
  sseUrl: string;
}

/** Lifecycle snapshot of the local LiteLLM BYOK proxy (mirrors proxy::ProxyStatus). */
export interface ProxyStatus {
  running: boolean;
  port?: number | null;
  url?: string | null;
  provider?: string | null;
  message?: string | null;
}

/** Args to start the proxy. `ciphertext` is the sealed key; the backend unseals it. */
export interface StartProxyArgs {
  provider: string;
  ciphertext?: string | null;
  model?: string | null;
  port?: number | null;
}

/**
 * Output of the two-stage image pipeline (§7), mirroring `image::ImageResult`.
 * `image` is a data-URI (placeholder SVG / FLUX png) or a remote URL (Ideogram);
 * `route` records which Stage-2 path was taken; `mock` is true if any stage fell
 * back (so the UI can badge a preview); `note` explains any degradation.
 */
export interface ImageResult {
  image: string;
  route: 'flux' | 'ideogram' | 'placeholder' | string;
  classification: 'typography_heavy' | 'standard' | string;
  expandedPrompt: string;
  mock: boolean;
  note?: string | null;
}

/**
 * Result of one conversational turn (mirrors `orchestrator::ChatResult`).
 * `text` is the assistant's final natural-language answer; `toolsUsed` lists the
 * (display) names of any connected MCP tools the model invoked along the way.
 */
export interface ChatResult {
  text: string;
  toolsUsed: string[];
  /** data: URIs of images produced by tools during the turn (e.g. screenshots). */
  images: string[];
}

/**
 * QR pairing payload from `remote_start_pairing` (mirrors `remote::PairingInfo`).
 * `keyB64Url` is the base64url AES-256 key — it crosses IPC ONLY so the webview can
 * draw it into the QR; the phone receives it by scanning, never via IPC.
 */
export interface PairingInfo {
  pairingId: string;
  keyB64Url: string;
  uri: string;
}

/**
 * Live connection state of the desktop Remote Control client (mirrors
 * `remote::RemoteStatus`). `paired` is true whenever a session is armed; `roomId`
 * is the non-secret pairing id (the key is never included).
 */
export interface RemoteStatus {
  state: 'offline' | 'connecting' | 'connected' | 'reconnecting' | string;
  paired: boolean;
  roomId: string | null;
}

/**
 * One side of a phone-driven turn, pushed via the `remote://turn` event so a remote
 * conversation renders LIVE in the desktop timeline (Phase 6). Emitted twice per turn
 * — `role:"user"` when the prompt arrives, `role:"assistant"` when the answer is ready
 * (same `id`). `conversationId` scopes it to the chat the phone is mirroring.
 */
export interface RemoteTurn {
  conversationId: string;
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolsUsed: string[];
  images: string[];
}

export const ipc = {
  // memory / conversation history
  listConversations: () => call<Conversation[]>('list_conversations'),
  /** Start a new session; returns the freshly-minted conversation row. */
  createConversation: (title?: string) =>
    call<Conversation>('create_conversation', { title: title ?? null }),
  /** Every stored turn for a session, oldest first (to replay the timeline). */
  listMessages: (conversationId: string) =>
    call<StoredMessage[]>('list_messages', { conversationId }),
  appendMessage: (conversationId: string, role: string, content: string) =>
    call<string>('append_message', { msg: { conversation_id: conversationId, role, content } }),
  /** Delete a conversation and all its messages (History sidebar trash action). */
  deleteConversation: (id: string) => call<void>('delete_conversation', { id }),

  // mcp
  listMcpServers: () => call<McpServerDto[]>('list_mcp_servers'),
  registerMcpServer: (server: McpServerDto) => call<void>('register_mcp_server', { server }),
  /** Aggregated tools across live servers; tools namespaced `server::tool`. */
  listMcpTools: () => call<ToolResult>('list_mcp_tools'),
  callMcpTool: (serverId: string, tool: string, args: unknown) =>
    call<ToolResult>('call_mcp_tool', { serverId, tool, args }),
  /** Loopback URL of the local axum MCP host, once it has bound (else null). */
  mcpHostInfo: () => call<HostInfo | null>('mcp_host_info'),

  // crypto (§5) — the front end only ever handles sealed strings; the master key
  // stays in the OS keychain on the Rust side and never crosses this boundary.
  /** Seal plaintext → opaque base64 blob (AES-256-GCM, random per-call nonce). */
  sealData: (plaintext: string) => call<string>('seal_data', { plaintext }),
  /** Unseal a blob from `sealData` (used to verify a stored key round-trips). */
  unsealData: (ciphertext: string) => call<string>('unseal_data', { ciphertext }),

  // byok
  storeApiKey: (provider: string, secret: string) =>
    call<void>('store_api_key', { provider, secret }),

  // byok proxy (local LiteLLM sidecar, §6) — the sealed key is unsealed backend-side
  startByokProxy: (args: StartProxyArgs) => call<ProxyStatus>('start_byok_proxy', { args }),
  stopByokProxy: () => call<ProxyStatus>('stop_byok_proxy'),
  getProxyStatus: () => call<ProxyStatus>('get_proxy_status'),

  // image (§7) — two-stage: qwen3-vl expand/classify → FLUX (local) or Ideogram.
  // The Ideogram key is unsealed backend-side; degrades to a placeholder offline.
  generateImage: (prompt: string, forceRoute?: string) =>
    call<ImageResult>('generate_image', { req: { prompt, force_route: forceRoute ?? null } }),

  // conversational orchestrator — plain English → the active provider/model with
  // the connected MCP tools injected (agentic loop). The provider key is unsealed
  // backend-side; `sessionId` carries history + persists the round-trip.
  submitChatMessage: (userPrompt: string, opts?: ChatOptions) =>
    call<ChatResult>('submit_chat_message', {
      userPrompt,
      provider: opts?.provider ?? null,
      model: opts?.model ?? null,
      sessionId: opts?.sessionId ?? null,
      images: opts?.images ?? null,
    }),

  // overlay
  summonOverlay: (origin: string) => call<void>('summon_overlay', { origin }),

  // remote control (§Phase 3) — mint an ephemeral E2E AES key + room id; returns the
  // `trenlens://pair` QR payload the desktop renders. Calling again rotates the key.
  remoteStartPairing: () => call<PairingInfo>('remote_start_pairing'),

  // remote control live connection (§Phase 4) — the headless Rust WebSocket client.
  /** Open the relay socket for the armed pairing. `jwt` is the Supabase access
   *  token (the relay verifies it at the upgrade); `relayUrl` overrides the local
   *  dev default. Returns the initial status (`connecting`). */
  remoteConnect: (jwt: string, relayUrl?: string) =>
    call<RemoteStatus>('remote_connect', { jwt, relayUrl: relayUrl ?? null }),
  /** Push a refreshed Supabase token; applied on the next reconnect. */
  remoteUpdateToken: (jwt: string) => call<void>('remote_update_token', { jwt }),
  /** Stop the client and DROP the E2E key (re-pair required to reconnect). */
  remoteDisconnect: () => call<RemoteStatus>('remote_disconnect'),
  /** Poll the current connection/pairing state. */
  remoteStatus: () => call<RemoteStatus>('remote_status'),
  /** Bind the active conversation as the shared session the phone mirrors (§Phase 6):
   *  pushes its timeline to the phone so it backfills + adopts the id. `null` clears.
   *  `provider`/`model` record the desktop's engine so phone turns run on it too. */
  remoteSetConversation: (sessionId: string | null, provider?: string | null, model?: string | null) =>
    call<void>('remote_set_conversation', {
      sessionId,
      provider: provider ?? null,
      model: model ?? null,
    }),

  /**
   * Open a URL in the user's default browser via the Tauri opener plugin
   * (`opener:default` capability). Falls back to `window.open` in the browser
   * preview. Used by the About dialog's "Download" / GitHub links.
   */
  openExternal: async (url: string): Promise<void> => {
    const invoke = getInvoke();
    if (invoke) {
      try {
        await invoke<void>('plugin:opener|open_url', { url, with: null });
        return;
      } catch {
        /* fall through to a plain window.open */
      }
    }
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  },

  // local SQL bridge (consumed by the Drizzle sqlite-proxy adapter in db.ts)
  executeSql: (query: string, params: unknown[]) =>
    call<{ rowsAffected: number; lastInsertRowid: number }>('execute_sql', { query, params }),
  /** Returns rows as positional value arrays (the sqlite-proxy contract). */
  querySql: (query: string, params: unknown[]) => call<unknown[][]>('query_sql', { query, params }),
};
