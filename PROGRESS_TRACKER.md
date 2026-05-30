# trenlens-core — Build Progress Tracker

A generalized, cross-platform standalone desktop AI assistant that orchestrates any
tool / web-app / CLI over the Model Context Protocol (MCP).

**Stack:** Tauri v2 (Rust host) · Next.js 15 (React/TS static export) · Drizzle ORM ·
local SQLite (rusqlite, bundled) · `rust-mcp-sdk` 0.9 · axum/hyper SSE host.

Legend: `[X]` completed · `[/]` in progress · `[ ]` remaining.

---

## [X] Phase 1 — Tauri Workspace Scaffolding

The foundation: a compiling Tauri v2 + Next.js 15 workspace with the full IPC
contract committed up front.

- Tauri v2 host (`src-tauri/`) with `withGlobalTauri`, shell/opener plugins,
  generated bundle icons.
- Next.js 15 static export (`output: 'export'`) front end with the premium
  dual-theme (dark/light) token system, Framer-Motion fluid timeline, Morphing
  Node, Typographic Unblur, ambient field, hover-summon overlay.
- The **typed IPC surface** (`src-tauri/src/commands.rs` ⇆ `src/lib/ipc.ts`):
  every privileged action's signature/DTO finalized as the stable contract,
  bodies stubbed so each subsystem could be filled in independently.
- Sibling module skeletons: `mcp/`, `memory/`, `crypto/`, `proxy/`.
- Next.js dependencies updated to clear lingering 15.x CVE advisories
  (verified empirically with `npm audit` before/after).

## [X] Phase 2 — Local stdio MCP Engine

The first live subsystem: outbound MCP over local stdio child processes.

- `rust-mcp-sdk` 0.9.0 wired with `default-features = false` + an explicit
  feature set (`client`, `server`, `stdio`, `sse`, `streamable-http`,
  `hyper-server`, `macros`).
- `mcp::McpRouter` — the in-process registry/source of truth. `connect()` launches
  a stdio server via `StdioTransport::create_with_server_launch`, drives the
  `McpClient` handshake (`start` / `request_tool_list` / `request_tool_call`),
  and namespaces every tool `server::tool`.
- IPC commands made real: `list_mcp_servers`, `register_mcp_server` (brings the
  session up *before* recording it, so a failed launch leaves no ghost),
  `list_mcp_tools` (aggregated, per-server errors surfaced in `content.errors`),
  `call_mcp_tool`.
- Front end wired live (`useMcp.ts`): the timeline is driven by real tool calls —
  Morphing Node lifecycle (spawn → processing → dissolving → done/error) bound to
  in-flight IPC, Typographic Unblur streaming the returned payload. Minimalist
  server-registration UI (Windows `npx.cmd` shim documented).
- Verified with `cargo check` (clean) and a `#[ignore]` stdio round-trip test
  against `@modelcontextprotocol/server-everything`.

## [X] Phase 3 — Network Layer & SSE Host

Two-directional MCP networking, both sharing one router.

- **Inbound:** a background **axum/hyper MCP host** (`mcp/host.rs`) spawned in the
  Tauri `setup` hook, bound to a free loopback port. `HostServerHandler` delegates
  `handle_list_tools_request` → `aggregate_tools` and `handle_call_tool_request`
  → `call_tool_typed`, re-exposing the aggregated registry to cooperating web apps.
- **Outbound:** `ClientStreamableTransport` (`StreamableTransportOptions`) for
  remote `sse` / `http` MCP servers.
- **Unified state (critical):** remote tools register into the **same**
  `Arc<McpRouter>` the IPC commands read, so the front end's `list_mcp_tools`
  returns one merged stdio + remote registry.
- **Security/CORS:** `HyperServerOptions` with `dns_rebinding_protection`,
  strict `allowed_origins` / `allowed_hosts` origin validation (§10).
- `mcp_host_info` IPC exposes the loopback URL to the UI. Verified clean
  `cargo check`.

## [X] Phase 4 — Memory & Database Proxy

The local persistence layer: Drizzle ORM (front end) → Tauri IPC → Rust-owned
SQLite, the BYOK plumbing.

- DB backend re-enabled on **rusqlite** (`bundled` → SQLite compiled from source;
  C toolchain confirmed working, so no mock fallback needed). Pinned to `0.32`
  because `0.40` pulls `libsqlite3-sys 0.38`, whose build script uses the unstable
  `cfg_select` feature and fails on stable rustc 1.94.
- `memory::MemoryHandle` (`Mutex<Connection>`): opens/migrates the DB at startup
  (`app_data_dir`), exposes `execute()` and `query()` returning rows as
  **positional value arrays** — exactly Drizzle's sqlite-proxy contract.
- **SQL bridge IPC:** `execute_sql` (run) + `query_sql` (read).
- **Custom Drizzle adapter** (`src/lib/db.ts`) on the official
  `drizzle-orm/sqlite-proxy` driver: routes generated SQL through `invoke`.
- BYOK Drizzle schema (`src/db/schema.ts`): `api_keys` (provider, label, baseUrl,
  `secretCiphertext` placeholder, timestamps) — mirrored by the Rust startup
  migration.
- On-mount pipeline probe in `useMcp.ts` proving Next.js → Tauri → SQLite, surfaced
  as a subtle "Local store · N keys" line in the config sidebar. Verified
  `cargo check` + `next build` clean.

## [X] Phase 5 — Crypto & Keychain Sealing

Securing the BYOK layer with authenticated row-level encryption and an
OS-keychain-held master key.

- [X] `crypto/mod.rs`: AES-256-GCM authenticated `seal` / `unseal` with random
  96-bit nonces (`nonce ‖ ciphertext+tag`, base64). Unit-tested: round-trip,
  per-call nonce uniqueness, wrong-key rejection, tamper detection (all pass).
- [X] Master key: 32 random bytes generated on first launch, persisted/retrieved
  from the **native OS vault** via the `keyring` crate — per-target backends so
  Windows uses the pure-Rust `windows-native` (Credential Manager), macOS the
  Security framework, Linux the Secret Service. Chosen over
  `tauri-plugin-stronghold` (a file-based snapshot vault, not the OS keychain).
- [X] `crypto::CryptoState` in Tauri managed state (unlocked in the `setup` hook);
  `seal_data` / `unseal_data` IPC commands. The front end stays blind to the
  master key — it only ever handles sealed strings.
- [X] BYOK registration UI (`ServerSidebar`): submit a key → `seal_data`
  intercepts plaintext → ciphertext written to the local DB via Drizzle →
  round-trip verified through `unseal_data`, surfaced by the `SealIndicator`
  micro-interaction (animated check + masked `••••tail`). Plaintext is discarded
  the instant it's sealed; the raw key is never persisted, logged, or displayed.
- [X] Verified: `cargo check` clean (only the two pre-existing stub warnings),
  4/4 crypto unit tests pass, `tsc --noEmit` clean, `next build` static export
  clean. Dual-theme UI unaffected.

**Honest caveat (consistent with prior phases):** verified at compile/build +
unit-test + data-contract level. The live OS-keychain round trip
(`load_or_create_master_key` touching Credential Manager) runs only inside the
launched desktop app — not exercised here, by request (no `tauri dev`).

## [X] Phase 6 — BYOK Proxy Loop

Supervise a local LiteLLM sidecar as an OpenAI-compatible proxy for external tools
(e.g. Claude Code → `http://127.0.0.1:4000`).

- [X] **Sidecar config:** `bundle.externalBin: ["binaries/litellm-proxy"]` in
  `tauri.conf.json`; `shell:allow-execute` + `shell:allow-spawn` granted to that
  sidecar (scoped) in `capabilities/default.json`. A compiled **mock**
  (`binaries/litellm-proxy-x86_64-pc-windows-msvc.exe`) prints the bind line and
  idles — enough to exercise the wiring without a Python toolchain.
- [X] **Rust supervisor** (`proxy/mod.rs`): `ProxyState` (Tauri-managed) uses
  `ShellExt::sidecar` to spawn the child with a generated `litellm_config.yaml`
  (in the app data dir) passed via `--config`; monitors the stdout event stream to
  detect the `127.0.0.1:<port>` bind line and reflect termination. The provider
  secret is injected via the child's **environment** (`os.environ/...`), never
  written to the yaml.
- [X] **IPC:** `start_byok_proxy` / `stop_byok_proxy` / `get_proxy_status`. The
  front end passes the **sealed ciphertext**; the backend unseals it with the
  Phase 5 crypto layer in-process — plaintext never crosses IPC.
- [X] **Frontend:** a Proxy section in `ServerSidebar` with a start/stop toggle,
  live status dot, and copy-able connection instructions ("Point Claude Code at
  http://127.0.0.1:4000"). On start it reads the chosen provider's sealed key from
  Drizzle and hands the ciphertext to the backend.
- [X] **Verified:** `cargo check` clean (2 known stub warnings only), 2/2 proxy
  unit tests pass, `tsc` + `next build` clean. The mock's spawn → bind-detect →
  kill lifecycle demonstrated end-to-end.
- [ ] **Remaining:** replace the mock with the real PyInstaller-packaged
  `litellm[proxy]` onefile binary (deferred — needs a Python build env). The Rust
  supervisor + IPC contract stay identical when swapped in.

**Design note:** the supervisor is initialised at startup but does **not**
auto-spawn — a keyless proxy is pointless, so spawning is gated on the user's
toggle + a saved provider key (the secure interpretation of "spawn on startup").

## [X] Phase 7 — 2-Stage Image Pipeline

`generate_image`: (1) expand the prompt via local Qwen3-VL, (2) route to
FLUX.1-schnell (local) or Ideogram 3.0 API (typography-heavy) — the router decides
unless `force_route` is given.

- [X] **Pipeline module** (`image/mod.rs`): Stage 1 POSTs to local Ollama
  (`/api/generate`, `qwen3-vl`, `format: json`) with a system prompt that expands
  the raw idea into a detailed diffusion prompt and classifies it
  `typography_heavy` | `standard`. Stage 2 routes: typography → the **Ideogram**
  API (key unsealed from the BYOK DB via §5); standard → local **FLUX.1-[schnell]**
  through ComfyUI (`:8188`, queue `/prompt` → poll `/history` → fetch `/view`,
  inlined as a data-URI). HTTP via `reqwest` (`rustls-tls`, no OpenSSL).
- [X] **Graceful degradation (dev rule):** every external hop catches connection
  errors. Ollama down → heuristic keyword expansion + classifier; FLUX/Ideogram
  down (or no key) → a self-describing SVG **placeholder** data-URI. The command
  always returns `Ok`, with a `mock` flag + human `note` recording what degraded.
- [X] **IPC:** `generate_image` wired to the pipeline; returns `ImageResult`
  `{ image, route, classification, expandedPrompt, mock, note }`. The Ideogram key
  is read sealed from `api_keys` and unsealed **backend-side** — plaintext never
  crosses IPC (§5).
- [X] **Frontend:** composer `/image <prompt>` (or `/image:flux` / `/image:ideogram`
  to force a route) triggers it. The **Morphing Node** breathes through both stages
  while the label morphs "expanding prompt…" → "rendering image…"; the expanded
  prompt and the final render reveal via the CSS `data-unblur` Typographic-Unblur.
- [X] **Verified:** `cargo check` clean (1 pre-existing `NewMessage` stub warning),
  6/6 new image unit tests pass (12/12 suite), `tsc --noEmit` clean, `next build`
  static export clean (route `/` 38.3 kB / 183 kB).
- [ ] **Remaining (deferred):** the FLUX workflow graph in `flux_schnell_workflow`
  is a TEMPLATE — model filenames/node ids are install-specific and should be
  matched to the user's local ComfyUI; the Ideogram body targets the stable JSON
  `/generate` contract (swap to the v3 multipart endpoint when going live). Both
  are reached only when those services are actually running.

**Honest caveat (consistent with prior phases):** verified at compile + unit-test +
build + data-contract level. The live model round-trips (Ollama expansion, a real
FLUX render, a real Ideogram call) run only with those daemons up inside the
launched desktop app — not exercised here, by request (no `tauri dev`). With
nothing running, the pipeline deterministically produces the placeholder path,
which *is* exercised by the unit tests.

---

**All 7 phases complete.** The desktop engine spans: MCP orchestration (stdio +
remote + inbound host), a local SQLite store behind a Drizzle proxy, OS-keychain
AES-GCM secret sealing, a supervised LiteLLM BYOK proxy, and a two-stage image
pipeline — all behind one typed Tauri IPC surface, with a graceful degradation
story at every external boundary.

---

## [X] Conversational Layer Addendum

Turns the strict command bar into a natural-language assistant: plain English is
routed to Claude with the connected MCP tools injected, so the model can call them
and answer (Option A — a **direct Anthropic Messages API** loop, no proxy needed).

- [X] **Orchestrator** (`orchestrator/mod.rs`, `run_chat`): a new
  `submit_chat_message(user_prompt)` command fetches the active **anthropic** key
  from the BYOK DB, unseals it via the §5 crypto state in-process, and issues an
  HTTPS request to `api.anthropic.com/v1/messages` with `reqwest` (`rustls-tls`).
- [X] **Dynamic MCP tool injection (agentic loop):** before each call it queries
  the live `McpRouter` (`list_tools`) and appends every connected tool as a native
  Anthropic `tools` declaration (names sanitised `server::tool` → `server__tool`,
  with a reverse map). On a `tool_use` stop it executes the tool via
  `McpRouter::call_tool`, feeds the `tool_result` back, and loops until the model
  produces a natural-language answer (bounded by `MAX_TOOL_ITERS = 6`).
- [X] **Frontend routing:** `useMcp.dispatch` sends plain English to
  `submit_chat_message`; `/image …` and explicit `server::tool {json}` still bypass
  the LLM unchanged. The reply streams word-by-word through `UnblurText`, and the
  in-flight turn drives a breathing `MorphingNode` ("thinking"); tools the model
  used are noted under the answer.
- [X] **Graceful errors:** no key / API error / tool failure are surfaced as a
  clean message, never a crash. Plaintext key never crosses IPC (unsealed
  backend-side, §5).
- [X] **Verified:** `cargo check` clean (1 pre-existing `NewMessage` warning), 5/5
  new orchestrator unit tests pass (17 pass + 1 ignored suite-wide), `tsc --noEmit`
  clean, `next build` static export clean (route `/` 38.6 kB / 183 kB).

**Honest caveat (consistent with prior phases):** verified at compile + unit-test +
build + data-contract level. The live API round-trip (a real Claude call + a real
tool_use loop) runs only with a valid anthropic key inside the launched app — not
exercised here. The pure helpers (tool-name sanitisation, schema normalisation,
result flattening, text extraction) are unit-tested; the agentic control flow is
built against the verified `McpRouter` contract (the stdio round-trip test pins the
exact `list_tools` / `call_tool` JSON the loop consumes).

**Design note:** this is the *direct* loop (Option A). It is independent of the §6
BYOK proxy (which points *external* tools like Claude Code at the user's keys); the
in-app assistant talks to Anthropic directly so it works today without the real
LiteLLM binary. Streaming-to-UI uses the existing frontend `UnblurText` word-chunk
animation over the final answer (the agentic loop needs complete `tool_use` blocks,
so the HTTP turns are non-streamed) — the visible effect is identical.


---

## [X] Engine Upgrade — History, Markdown, Multi-Provider, Model Selection

Five-part upgrade to the desktop engine: persistent conversation history, proper
Markdown rendering, two new providers (DeepSeek + Kimi), dynamic model selection
with cost badges, and multi-provider orchestrator routing.

- [X] **Conversation history (persistent).** `memory/mod.rs` migrations now create
  `conversations`, `messages` (indexed `(conversation_id, created_at)`), and
  `settings`. New semantic methods (`create_conversation`, `list_conversations`,
  `append_message`, `list_messages`, `set_conversation_title`) own id-minting and
  `updated_at`/title bookkeeping. The old `append_message` stub is **fixed** — every
  user prompt, assistant answer, and tool/image run is written to `trenlens.db` and
  survives a restart. New commands: `create_conversation`, `list_messages` (+ the
  now-real `list_conversations`/`append_message`). 4 new memory unit tests.
- [X] **History sidebar (frontend).** A collapsible left rail (`HistorySidebar.tsx`,
  toggled from the `ConnectionBar`) lists sessions most-recent-first, read from the
  DB on startup. "+ New chat" starts a fresh session; clicking a session replays its
  stored messages onto the timeline (tool/image turns round-trip via a JSON payload).
- [X] **LLM-named sessions.** On the first turn the backend asks the model for a
  concise title from the opening message — run **concurrently** with the answer via
  `tokio::join!`, so it adds no perceptible latency (it only needs the prompt). Falls
  back to a message snippet on any error.
- [X] **Markdown presentation.** `react-markdown` + `remark-gfm` render the *settled*
  assistant answer (headings, lists, tables, **bold**, `code`) via `<Markdown>` +
  `.tren-md` token-driven styles. The per-character Typographic Unblur is preserved:
  it runs on the raw text **while streaming**, then the formatted block eases in with
  the same `data-unblur` blur→sharp mechanism once the stream settles.
- [X] **Providers + model selection.** A shared registry (`lib/models.ts`) adds
  **DeepSeek** and **Kimi (Moonshot)** to the BYOK provider picker and a dynamic
  **Model** dropdown below it, with relative **cost badges** (Sonnet = 1×):
  Anthropic `claude-sonnet-4-6` 1× / `claude-opus-4-8` ~5× / `claude-haiku-4-5`
  ~0.3×; Kimi `kimi-k2.5` ~0.2× / `kimi-k2.6` ~0.3×; DeepSeek `deepseek-v4-flash`
  ~0.02× / `deepseek-v4-pro` ~0.15×. The selection persists to the `settings` table and is
  restored on reboot. New keys for any provider still flow through the §5
  `seal_data` boundary unchanged.
- [X] **Multi-provider routing (`orchestrator/mod.rs`).** `submit_chat_message` now
  accepts `provider`, `model`, and `session_id`. It loads the session's prior
  user/assistant turns for **multi-turn context**, then routes by provider:
  anthropic → Messages API; **deepseek** → `api.deepseek.com/v1/chat/completions`;
  **kimi** → `api.moonshot.cn/v1/chat/completions` (both OpenAI-compatible). The MCP
  tool-call agentic loop is implemented in **both** the Anthropic (`tool_use`) and
  OpenAI (`tool_calls`) shapes from one shared `ToolCatalog`. Keys are unsealed
  in-process per provider — plaintext never crosses IPC or gets logged (§5).
- [X] **Verified:** `cargo check` clean; **25/25** Rust unit tests pass (1 ignored) —
  +4 memory, +5 orchestrator (sanitise, collision, schema, decls-share-resolver,
  pick-default, clean-title, api-error); `tsc --noEmit` clean; `next build` static
  export clean (route `/` 83.7 kB / 229 kB — the react-markdown weight).

**Honest caveat (consistent with prior phases):** verified at compile + unit-test +
build + data-contract level. The live API round-trips (real Claude/DeepSeek/Kimi
calls + the tool loop + title generation) run only with valid keys inside the
launched app — not exercised here. Conversation persistence and the history replay
are exercised by the in-memory SQLite unit tests; the provider-routing branch points
and both tool-call formats are unit-tested at the catalogue/parse level.

**Design notes.** (1) Chat turns are persisted **backend-side** under `session_id`
(atomic with the answer); tool/image turns are persisted **frontend-side** as a JSON
payload under role `tool` so they replay into rich entries. (2) Image data-URIs are
stored inline — fine for placeholders/Ideogram URLs; a large local FLUX png will
bloat the row (future: store a file path instead). (3) Picking a non-chat provider
(ideogram/openai/…) then chatting falls into the Anthropic branch and will surface a
clean key/endpoint error — the Model dropdown hides for those, signalling they're
key-storage only.
