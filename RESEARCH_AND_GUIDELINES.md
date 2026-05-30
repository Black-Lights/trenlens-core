# TrenLens Core — Research & Architectural Guidelines

> A generalized, cross-platform **standalone desktop AI assistant** that orchestrates
> any tool, web app, or CLI through the **Model Context Protocol (MCP)**.
>
> Status: **foundation scaffolding**. Subsystems are stubbed with final IPC/type
> contracts; this document is the binding spec for the implementation phases.

---

## 0. Context — what we learned from the `trenlens` staging project

The staging repo (`../trenlens`, a Cloudflare Workers monorepo) informed three
decisions by showing us what to **invert** for a desktop host:

| Concern | Staging `trenlens` (web platform) | `trenlens-core` (desktop host) |
| --- | --- | --- |
| MCP role | An MCP **server** — exposes *its own* tools over JSON-RPC/HTTP at `/mcp`, Bearer `trn_…` auth, RBAC-filtered tool list (`packages/api/src/routes/mcp-routes.ts`). | An MCP **host/client** — connects out to *many* servers over multiple transports and aggregates their tools. |
| Image generation | Single-stage router (`packages/ai/src/generate-image.ts`): SDXL on Workers AI / OpenAI GPT-Image / Replicate → R2. No vision prompt-expansion, no typography routing. | **Two-stage**: local vision prompt-expansion → route to local FLUX.1 [schnell] *or* Ideogram 3.0 for typography. |
| Assistant UI | Docked side `ChatPanel` with a floating FAB + pulsing "agent running" badge, standard chat **bubbles**, `ToolExecutingIndicator` (rotating lens ring). | Frameless, **bubble-free** continuous timeline with Morphing Nodes; web apps summon an overlay via a hover button. |

Reusable mental models carried over: JSON-RPC envelope shape, role/permission
gating on tools, and SSE for streaming. Everything else is re-architected for a
local-first, multi-server desktop runtime.

---

## 1. System overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Tauri v2 Window  (transparent, frameless)                                 │
│                                                                            │
│  ┌──────────────────────────── WEBVIEW (Next.js / React / TS) ─────────┐   │
│  │  Dual-theme timeline UI · Morphing Nodes · Typographic Unblur        │   │
│  │  Drizzle schema (authoring only) · framer-motion · next-themes       │   │
│  └──────────────┬───────────────────────────────────────────────────────┘  │
│                 │  window.__TAURI__.invoke  (the ONLY trust boundary)       │
│  ┌──────────────▼──────────────── RUST CORE (host process) ─────────────┐   │
│  │  commands.rs  — typed IPC surface                                    │   │
│  │  mcp/         — multi-transport router (stdio · axum SSE · http)     │   │
│  │  memory/      — encrypted libsql (sole DB owner)                     │   │
│  │  crypto/      — Argon2id KDF + AES-256-GCM secret sealing            │   │
│  │  proxy/       — local LiteLLM BYOK supervisor (127.0.0.1)            │   │
│  └──────┬───────────────┬───────────────┬───────────────┬──────────────┘   │
└─────────┼───────────────┼───────────────┼───────────────┼──────────────────┘
          │ stdio         │ SSE/HTTP      │ libsql file   │ localhost:port
     local MCP        remote MCP /     encrypted       LiteLLM ⇆ provider
     tool procs       web apps         memory.db        APIs (BYOK)
```

**Design tenets**

1. **Local-first.** All memory and secrets live on-device in an encrypted DB.
2. **One trust boundary.** The webview is treated as semi-trusted; every
   privileged action is a named `#[tauri::command]`. No raw FS/shell to JS.
3. **Transport-agnostic orchestration.** A tool call looks identical to the UI
   whether it lands on a stdio child, a remote SSE app, or an HTTP endpoint.
4. **BYOK, never our keys.** The app ships no provider credentials; users supply
   their own, sealed at rest, brokered through a local proxy.

---

## 2. Framework — Tauri v2 (Rust + Next.js)

- **Frontend**: Next.js (App Router) exported as a **static** bundle
  (`output: 'export'`, `distDir: 'dist'`) so it runs fully client-side inside
  the webview. `tauri.conf.json → build.frontendDist = "../dist"`, `devUrl`
  points at the Next dev server for `tauri dev`.
- **`withGlobalTauri: true`** is required so the global `window.__TAURI__.invoke`
  is injected (the frontend reads the global rather than importing
  `@tauri-apps/api`, keeping the same bundle runnable in a plain browser for
  design work — see `src/lib/ipc.ts`).
- **Transparent, frameless window** (`transparent: true`) to let the obsidian /
  alabaster canvas blend into the OS and support rounded corners. A
  `data-tauri-drag-region` strip in `ConnectionBar` provides the move handle.
- **CSP** is set in `tauri.conf.json`: `connect-src` allows `ipc:`, localhost
  (proxy + dev), and `https:`; `img-src` allows `asset:`/`data:` for generated
  images.
- **Rust crate layout** (`crate-type` includes `cdylib` for mobile parity):
  `lib.rs` wires plugins + `invoke_handler`; subsystems live in `mcp/`,
  `memory/`, `crypto/`, `proxy/`; `commands.rs` is the IPC surface.

---

## 3. MCP engine — `rust-mcp-sdk`, multi-transport routing

The Rust core is an **MCP host** maintaining one live client session per
registered server. Implemented in `src-tauri/src/mcp/` on top of `rust-mcp-sdk`.

### 3.1 Transports

| `transport` | When | How |
| --- | --- | --- |
| `stdio` | **Local** tools (filesystem, git, language servers, CLIs) | Spawn a child process via the shell plugin; speak JSON-RPC over its stdin/stdout using the SDK's stdio client. Process lifecycle (spawn/health/kill) is owned by the router. |
| `sse` | **Remote apps / web apps** | Two directions: (a) **client** — connect to a remote app's SSE endpoint; (b) **host** — expose an **`axum`-based SSE server** bound to `127.0.0.1` so cooperating local web apps can reach the host's aggregated tool registry. |
| `http` | Stateless remote servers (e.g. the staging `trenlens` Worker) | One JSON-RPC `POST` per call with a Bearer key. |

### 3.2 Router responsibilities (`McpRouter`)

- `connect(server_id, transport)` — establish/reuse a session; persist server in
  libsql (`mcp_servers` table).
- `list_tools()` — fan out `tools/list` across all sessions and **namespace**
  results by server (`server_id::tool_name`) to avoid collisions.
- `call_tool(server_id, tool, args)` — dispatch a single `tools/call` over the
  owning transport; normalize the result envelope back to the UI.
- **Concurrency**: sessions run on a Tokio runtime; each in-flight call maps 1:1
  to a Morphing Node on the timeline (`tool_runs` row → node phase).
- **Failure isolation**: a crashed stdio child or dropped SSE stream marks only
  that server `live:false` (reflected in `ConnectionBar`), never the whole app.

### 3.3 JSON-RPC contract (carried from staging)

`initialize` → `tools/list` → `tools/call`, plus `resources/list` /
`resources/read`. Protocol version pinned per `rust-mcp-sdk`. Role/permission
gating from the staging server generalizes to **per-server capability scopes**
the user grants at registration time.

> **Status:** all three transports are implemented. **`stdio`** is runtime-
> verified; **`sse`/`http`** connect outbound via `rust-mcp-sdk`'s
> `ClientStreamableTransport` (modern Streamable HTTP), merging remote tools into
> the same `McpRouter`. The **inbound axum host** (§3.1b) is implemented in
> `mcp/host.rs` and runs in the background. See §11 for the status delta.

---

## 4. Local memory — SQLite, Drizzle-over-IPC

**The Rust side is the sole owner of the database file.** The frontend never
opens a connection — it reaches the DB through an IPC SQL bridge.

- **Engine**: `rusqlite` with the **`bundled`** feature (SQLite compiled from
  source via `cc`). *Deviation from the original libsql plan* — see the box
  below and §11.
- **Access path — Drizzle sqlite-proxy over IPC**: the frontend runs a real
  Drizzle instance built on `drizzle-orm/sqlite-proxy` (`src/lib/db.ts`). Drizzle
  generates SQL + params + a method (`run`/`all`/`get`/`values`) and hands them
  to a callback that routes them over Tauri IPC: `run` → `execute_sql`, reads →
  `query_sql`. Rust returns rows as **positional value arrays**, which is exactly
  what sqlite-proxy maps back onto the selected columns. `commands.rs` ⇆
  `memory/mod.rs` (`MemoryHandle`, a `Mutex<rusqlite::Connection>` in Tauri
  state). `src/lib/ipc.ts` retains the semantic commands too.
- **Schema authoring**: `src/db/schema.ts` (Drizzle) is the single source of
  truth and also types the frontend. Rust applies an embedded `CREATE TABLE IF
  NOT EXISTS` migration at startup mirroring it; `drizzle-kit generate` can still
  emit DDL to `src-tauri/migrations/` (no `driver` in `drizzle.config.ts`).
- **Tables** (see `schema.ts`): `conversations`, `messages`, `mcp_servers`,
  `tool_runs`, `api_keys` (BYOK config, ciphertext only), `settings`. *Only
  `api_keys` is migrated in Rust so far* — the rest land with their features.

```
schema.ts ──┬─ drizzle-kit generate ─▶ migrations/*.sql (authoring)
            └─ Drizzle (sqlite-proxy) ─▶ invoke(execute_sql|query_sql) ─▶ rusqlite (bundled)
```

> **⚠ Security & architecture deviation.** A generic `execute_sql`/`query_sql`
> bridge is a **broader trust surface** than the original semantic-only IPC
> (§10): the semi-trusted webview can run arbitrary *single* statements against
> the local DB. Mitigations: plaintext provider keys **never** cross IPC (only
> sealed ciphertext is ever stored, §5); each call runs exactly one statement
> (`rusqlite::execute` / a single `prepare`). Also, the DB file is **not yet
> encrypted at rest** (libsql's encryption was the original §4 plan) — row-level
> AES-GCM sealing (§5) still protects secrets, and SQLCipher
> (`bundled-sqlcipher`) or a move back to libsql can add file-level encryption
> later without changing this surface.

---

## 5. BYOK & secret sealing (`crypto/`)  — IMPLEMENTED

- The **master key** is **32 random bytes generated on first launch** and stored
  in the **native OS vault** via the `keyring` crate (Windows Credential Manager /
  macOS Keychain / Linux Secret Service). It is loaded into `crypto::CryptoState`
  (Tauri managed state) in the `setup` hook and **never crosses IPC**.
- Individual provider keys are sealed with **AES-256-GCM** (a fresh random 96-bit
  nonce per `seal`). Only `nonce ‖ ciphertext+tag` (base64) is stored in
  `api_keys`; the GCM tag makes decryption fail closed on tampering/wrong key.
- Plaintext keys are unsealed **only** to (a) launch the LiteLLM proxy or (b)
  inject request headers — and are **never** returned to the webview as a
  resource. `unseal_data` exists for the registration **round-trip check** only;
  the UI compares in-memory then discards the plaintext.

> **⚠ Deviation from the original §5 plan (documented):**
> - **Master key is random + keychain-stored, not Argon2id-*derived* from a user
>   passphrase.** Rationale: the OS vault already provides at-rest protection and
>   a passwordless UX; deriving from a passphrase would add a prompt without a
>   threat-model win here. `crypto::derive_master_key` (Argon2id) is retained for
>   an **optional** future "protect with a passphrase" mode.
> - **Vault = `keyring` crate, not `tauri-plugin-stronghold`.** Stronghold is a
>   *file-based* encrypted snapshot vault (with its own password), which is **not**
>   the native OS keychain the architecture calls for. `keyring` maps 1:1 onto each
>   platform's native store and compiles pure-Rust on Windows (`windows-native`).
> - The master key does **not** yet unlock DB-file encryption (we use rusqlite, not
>   libsql — see §4). Row-level sealing still protects every secret; file-level
>   encryption can be layered later via SQLCipher.

---

## 6. BYOK proxy — local LiteLLM layer  — IMPLEMENTED (mock sidecar)

- `proxy/` (`ProxyState`, Tauri-managed) supervises a **LiteLLM** process bound to
  `127.0.0.1:4000` (launched as a Tauri **sidecar** via `ShellExt::sidecar`;
  configured by `bundle.externalBin: ["binaries/litellm-proxy"]`). It writes a
  minimal `litellm_config.yaml` to the app data dir and passes it via `--config`,
  then watches the child's stdout event stream for the `127.0.0.1:<port>` bind
  line. The provider key is injected through the child's **environment**
  (`os.environ/<KEY_ENV>` in the yaml), never written to disk in plaintext.
- IPC: `start_byok_proxy` / `stop_byok_proxy` / `get_proxy_status` return a
  `ProxyStatus { running, port, url, provider, message }`.
- The supervisor is initialised at startup but **does not auto-spawn** — spawning
  is user-gated (toggle + a saved provider key), since a keyless proxy is pointless.

> **⚠ Deviation / status notes:**
> - **Mock sidecar.** `binaries/litellm-proxy-<triple>.exe` is currently a compiled
>   Rust mock that prints the bind line and idles (no Python build env yet). The
>   real PyInstaller-packaged `litellm[proxy]` onefile swaps in without changing
>   the supervisor or IPC. (See `binaries/litellm-proxy-mock.rs` to regenerate.)
> - **Backend-side unseal.** The plan said the *frontend* unseals via `unseal_data`
>   and passes the key; instead the frontend passes the **sealed ciphertext** and
>   the backend unseals it in-process with the Phase 5 crypto layer — so plaintext
>   **never crosses IPC** (strictly stronger than the literal plan).
- External tools point at the local proxy instead of the provider directly. This
  lets users wire e.g. **Claude Code** to TrenLens Core:
  - Base URL → `http://127.0.0.1:<port>`.
  - Custom routing/headers are injected by the proxy; per-provider headers such
    as **`ANTHROPIC_CUSTOM_HEADERS`** are set there (e.g. to tag traffic, pin a
    beta, or attribute usage) so the user configures one local endpoint and the
    proxy handles provider specifics.
- Benefits: one switchboard for many providers, central spend/rate visibility,
  and keys that never live in third-party tool configs.

> Security note: the proxy listens on loopback only; the bound port is returned
> from `start_byok_proxy()` and surfaced to the user, never auto-broadcast.

---

## 7. Web-app hooks — hover button → overlay (STRICT)

Cooperating web apps integrate a **hover button** that summons the assistant
overlay. This is the most security-sensitive surface; the rules are strict.

### 7.1 Trigger contract

```js
// Embedded in the third-party web app. Reference impl: src/components/overlay/HoverSummon.tsx
if (window.__TAURI__) {
  await window.__TAURI__.invoke('summon_overlay', { origin: window.location.origin });
}
```

- Requires **`withGlobalTauri: true`** (so `invoke` exists in the embedded
  webview).
- In a plain browser the global is absent → the button degrades to a no-op
  tooltip, so the **same markup ships everywhere**.

### 7.2 Strictly scoped Tauri v2 Capabilities

Embedded/remote webviews are **untrusted**. They receive ONLY the
`webapp-overlay` capability (`src-tauri/capabilities/webapp-overlay.json`):

- Scoped to the `overlay` window label and an **allow-listed `remote.urls`** set
  (e.g. `https://*.trenlens.com`). Origins outside the list get nothing.
- Permits only the overlay summon/dismiss **events** — **no** DB, **no** BYOK,
  **no** MCP management, **no** access to the main window.
- The Rust `summon_overlay` command **re-validates** the calling origin against
  the allow-list before showing/focusing the overlay (defense in depth; never
  trust the JS-supplied origin alone).

The main window uses the separate `default` capability (`core:default` plus a
minimal, explicit set) — privileged commands are reachable only from there.

### 7.3 UX

The hover button is a radiant pulse affordance that expands on hover
("Ask TrenLens"); summoning animates the overlay in with the same Typographic
Unblur language as the rest of the app.

---

## 8. Image pipeline — two-stage

```
user prompt
   │
   ▼  Stage 1 — PROMPT EXPANSION (local vision model, e.g. Qwen3-VL)
      • enrich sparse prompts; incorporate any attached reference image
      • emit a structured prompt + a route hint (typography? photoreal? icon?)
   │
   ▼  Stage 2 — ROUTING
      ├─ default / prototyping ........ local FLUX.1 [schnell]  (fast, on-device, free)
      └─ typography-heavy requests ..... Ideogram 3.0 API       (BYOK via proxy)
   │
   ▼  result → cached locally → unblurs into the timeline
```

- **Stage 1** runs locally (Qwen3-VL class vision model) to expand/normalize the
  prompt and decide the route. Vision input lets it honor reference images.
- **Stage 2 routing**:
  - **FLUX.1 [schnell]** locally for fast prototyping / iteration (no network,
    no cost).
  - **Ideogram 3.0** (remote, BYOK through the LiteLLM proxy) when the request
    is **typography-heavy** (posters, logos, text-in-image) where Ideogram's
    legibility wins.
- A `force_route` override is exposed on `generate_image` (`commands.rs`) for
  power users / evals. Results render with the Typographic Unblur treatment.

> **IMPLEMENTED (§7) — with graceful degradation.** `image/mod.rs` runs Stage 1
> against local **Ollama** (`/api/generate`, `qwen3-vl`, `format: json`) for
> expansion + classification, then Stage 2 routes to local **FLUX.1-[schnell]**
> via ComfyUI (`:8188`) or the **Ideogram** API. HTTP is `reqwest` (`rustls-tls`,
> no OpenSSL). The Ideogram key is read **sealed** from `api_keys` and unsealed
> backend-side (§5) — plaintext never crosses IPC. `generate_image` returns
> `ImageResult { image, route, classification, expandedPrompt, mock, note }`; the
> composer `/image <prompt>` (`/image:flux` / `/image:ideogram` to force a route)
> triggers it, the Morphing Node breathes through "expanding → rendering", and the
> render reveals via the CSS `data-unblur`. **Deviations:** every external hop
> catches connection errors and falls back to a heuristic expansion / a
> self-describing SVG **placeholder** (so the command always returns `Ok` with no
> models installed); the FLUX workflow graph is an install-specific **template**;
> the Ideogram body targets the stable JSON `/generate` contract (swap to the v3
> multipart endpoint when going live). Live model round-trips run only with those
> daemons up (not exercised without `tauri dev`); the placeholder path is
> unit-tested.

---

## 9. UI / UX design language (dual-theme)

Full implementation in `src/components/`. The system is **token-driven**
(`globals.css` + `tailwind.config.ts`); components never hard-code colors.

### 9.1 Dual-theme compliance

| | **Dark** (default) | **Light** |
| --- | --- | --- |
| Surfaces | obsidian / charcoal (`--c-canvas: 9 10 13`) | alabaster / porcelain (`--c-canvas: 244 243 240`) |
| Typography | porcelain ink | deep charcoal ink |
| Pulse hue | radiant azure-violet, assertive | radiant indigo, **subtle / translucent** (`--ambient-opacity` lowered) |

- Theme handoff is a **Framer Motion canvas wipe**: a circle of the incoming
  canvas color expands from the click origin; the palette flips underneath at
  its apex, then the cover dissolves (`ThemeTransition.tsx`,
  driven by `next-themes`).

### 9.2 Required primitives

- **No chat bubbles, no pill badges.** Differentiation is by spine marker + type
  weight, not container fills.
- **Continuous timeline** (`Timeline.tsx`): one living spine; a travelling light
  packet animates along it while work is active.
- **Morphing Nodes** (`MorphingNode.tsx`): tool executions as minimalist
  geometric nodes — a dot **blooms** into a ring, **breathes** (scale/opacity +
  orbiting tracer) while processing, then **dissolves** (blur+expand+fade) as its
  output unblurs in; settles to a solid marker on done.
- **Typographic Unblur** (`UnblurText.tsx`, `globals.css`): streaming text /
  images mount blurred (CSS `filter: blur`) and **sharpen into focus**; only
  freshly-arrived characters animate, so long streams stay cheap.
- **Ambient pulses** (`AmbientField.tsx`, `ConnectionBar.tsx`): slow drifting
  blooms in the pulse hue intensify while a backend stream is live; each MCP
  connection is a breathing pulse dot whose glow = an active link.
- **Accessibility**: `prefers-reduced-motion` disables blur/transform and shortens
  transitions (`globals.css`).

---

## 10. IPC surface (current contract)

`src/lib/ipc.ts` (TS) ⇆ `src-tauri/src/commands.rs` (Rust). **Signatures are
final**; the mcp, memory/SQL-bridge, crypto, proxy, and image commands are
implemented — only overlay + conversation persistence remain stubbed.

| Command | Purpose | Subsystem |
| --- | --- | --- |
| `list_conversations` / `append_message` | timeline persistence | memory |
| `execute_sql` / `query_sql` | Drizzle sqlite-proxy SQL bridge | memory |
| `list_mcp_servers` / `register_mcp_server` / `list_mcp_tools` / `call_mcp_tool` | orchestration | mcp |
| `mcp_host_info` | loopback URL of the axum MCP host (for web apps) | mcp/host |
| `seal_data` / `unseal_data` | AES-256-GCM seal/unseal; master key stays in OS keychain | crypto |
| `start_byok_proxy` / `stop_byok_proxy` / `get_proxy_status` | LiteLLM sidecar lifecycle (sealed key unsealed backend-side) | proxy |
| `store_api_key` | superseded by `seal_data` + Drizzle write (reserved) | crypto |
| `generate_image` | two-stage pipeline (qwen3-vl expand → FLUX/Ideogram); returns image + route metadata | image |
| `summon_overlay` | web-app hover-button entry | overlay |

---

## 11. Implementation status

**Implemented & verified (this phase):**

- **MCP `stdio` transport** (`mcp/mod.rs`): `McpRouter` on `rust-mcp-sdk` 0.9 —
  `connect` spawns a stdio child + runs MCP `initialize`; `list_tools` fans out
  and namespaces tools as `server::tool`; `call_tool` dispatches `tools/call`;
  per-server failures are isolated, and re-registering an id tears down the old
  child first. Surfaced through `register_mcp_server` / `list_mcp_servers` /
  `list_mcp_tools` / `call_mcp_tool` over a Tauri-managed `McpRouter`. Verified
  by a runtime round-trip against `@modelcontextprotocol/server-everything`
  (`cargo test stdio_roundtrip -- --ignored`).
- **Frontend → live IPC** (`src/lib/useMcp.ts`, `src/app/page.tsx`): the timeline
  is driven by real `list_mcp_servers` / `list_mcp_tools` / `register_mcp_server`
  / `call_mcp_tool` — no scripted turns remain. A tool call drives the Morphing
  Node through its real lifecycle (spawn → processing while the native call is in
  flight → dissolving as the payload streams through Typographic Unblur → done /
  error); the ConnectionBar/sidebar reflect live servers; tools register on the
  fly via a minimalist stdio form (the round-trip test pins the exact JSON the
  parsers consume). The composer is a `server::tool {json}` command bar (no LLM
  in the loop yet).

- **MCP `sse`/`http` (outbound) + axum host (inbound)** (`mcp/mod.rs`,
  `mcp/host.rs`): `connect` for `sse`/`http` opens a `ClientStreamableTransport`
  session, so a remote MCP server / web app's tools merge into the SAME
  `McpRouter` — `list_mcp_tools` is transport-agnostic. A background **axum/hyper
  MCP host** (`rust-mcp-sdk` `hyper-server`) bound to `127.0.0.1:<ephemeral>`
  re-exposes that aggregated registry to cooperating web apps over Streamable
  HTTP (`/mcp`) + SSE (`/sse`), with `dns_rebinding_protection` + an
  `allowed_origins` allow-list (§7/§10). The bound URL is surfaced via
  `mcp_host_info`. Compiles clean (`cargo check`).

- **Local DB + Drizzle-over-IPC** (`memory/mod.rs`, `commands.rs`, `src/lib/db.ts`):
  `rusqlite` (`bundled`) owns the on-device SQLite file (opened + migrated at
  startup, managed in Tauri state). The `execute_sql` / `query_sql` bridge backs
  a real Drizzle instance on `drizzle-orm/sqlite-proxy`, so the frontend issues
  type-safe Drizzle queries that execute in Rust. The `api_keys` (BYOK) table is
  live; an on-mount probe in `useMcp.ts` upserts + reads a row to prove the
  Next.js → Tauri → SQLite pipeline (status shown in the sidebar). See the §4
  deviation box (rusqlite vs libsql; raw-SQL surface; at-rest encryption pending).

- **Crypto sealing + OS keychain** (`crypto/mod.rs`, `commands.rs`,
  `src/lib/useMcp.ts`, `ServerSidebar.tsx`): AES-256-GCM `seal`/`unseal` with a
  random per-call 96-bit nonce (`nonce ‖ ciphertext+tag`, base64), unit-tested
  (round-trip, nonce uniqueness, wrong-key + tamper fail-closed). The 32-byte
  master key is generated on first launch and held in the **native OS vault** via
  `keyring` (Windows Credential Manager / macOS Keychain / Linux Secret Service),
  loaded into `CryptoState` in `setup` and never crossing IPC. Exposed as
  `seal_data` / `unseal_data`. The BYOK form seals the typed key, persists only
  the ciphertext via Drizzle, and shows a round-trip-verified micro-interaction
  (masked `••••tail`, no raw key surfaced). See the §5 deviation box (random
  keychain key vs Argon2id-derived; `keyring` vs Stronghold). `cargo check` +
  `next build` clean.

- **BYOK proxy supervisor** (`proxy/mod.rs`, `commands.rs`, `useMcp.ts`,
  `ServerSidebar.tsx`): `ProxyState` spawns a LiteLLM **sidecar** via
  `ShellExt::sidecar` (`externalBin` + scoped `shell:allow-execute`/`-spawn`),
  generates `litellm_config.yaml`, passes it via `--config`, and monitors stdout
  for the `127.0.0.1:<port>` bind line. `start_byok_proxy` / `stop_byok_proxy` /
  `get_proxy_status` drive a sidebar toggle with copy-able connection
  instructions. The front end passes the **sealed** key; the backend unseals it
  in-process and injects it via the child's env (plaintext never crosses IPC nor
  disk). Currently a compiled **mock** sidecar (no Python env); the supervisor +
  IPC are unchanged when the real PyInstaller binary swaps in. `cargo check` +
  `next build` clean; 2/2 proxy unit tests pass; spawn→bind→kill demonstrated.

- **Two-stage image pipeline** (`image/mod.rs`, `commands.rs`, `useMcp.ts`,
  `TimelineEvent.tsx`): Stage 1 expands + classifies (`typography_heavy` |
  `standard`) via local Ollama (`qwen3-vl`); Stage 2 routes to local FLUX.1-schnell
  (ComfyUI `:8188`) or the Ideogram API (key unsealed backend-side, §5). HTTP via
  `reqwest` (`rustls-tls`). Every external hop degrades to a heuristic expansion /
  SVG placeholder, so `generate_image` always returns `Ok` — it returns
  `ImageResult` with `route`/`classification`/`expandedPrompt`/`mock`/`note`. The
  composer `/image <prompt>` drives the Morphing Node through "expanding →
  rendering" and reveals the render via the CSS `data-unblur`. `cargo check` clean,
  6/6 image unit tests pass, `tsc` + `next build` clean. (See §8 deviation box:
  placeholder fallback, FLUX workflow template, Ideogram JSON endpoint.)

**Still stubbed** (`todo!()` / placeholder returns) with finalized contracts:

- Conversation/message persistence (`memory/` — only `api_keys` is migrated +
  wired so far; `list_conversations` / `append_message` remain stubs).
- DB-file at-rest encryption (SQLCipher/libsql) — row-level sealing is done (§5),
  whole-file encryption still pending.
- The real LiteLLM binary (`proxy/` currently runs a compiled **mock** sidecar;
  supervision + IPC are live — only the PyInstaller `litellm[proxy]` bundle is
  pending, §6).
- Live image models (`generate_image` is fully wired, §7 — but the actual Ollama /
  FLUX / Ideogram round-trips need those daemons running; with nothing up the
  pipeline returns the placeholder path). The FLUX workflow graph is an
  install-specific template; the Ideogram endpoint may need the v3 multipart form.
- An LLM orchestration loop (the composer is a manual `server::tool` / `/image`
  command bar; natural-language → tool selection arrives with the BYOK proxy, §6).

**Dependency / build deltas this phase:**

- `next` `15.5.4 → 15.5.18` (the security `backport` line) — clears every
  Next.js CVE advisory; static export + typecheck re-verified.
- `rust-mcp-sdk` `0.4 → 0.9`, `default-features = false`, now
  `features = ["client","server","stdio","sse","streamable-http","hyper-server","macros"]`
  (SSE host + streamable client); added `async-trait`.
- **`libsql` dropped in favour of `rusqlite` (`bundled`), pinned `0.32`.** The C
  toolchain turned out to work (ring/SQLite compile fine), so the earlier
  in-memory fallback was unnecessary. Pinned to 0.32 because rusqlite `0.40`
  pulls `libsqlite3-sys 0.38`, whose build script uses the unstable `cfg_select`
  feature and fails on stable rustc 1.94.1. (See §4 deviation box.)
- **Crypto deps added:** `aes-gcm 0.10` + `base64 0.22` (sealing), `argon2 0.5`
  (retained for the optional passphrase path). `keyring 3` added **per-target** so
  Windows pulls only the pure-Rust `windows-native` backend (macOS `apple-native`,
  Linux `sync-secret-service` + `crypto-rust`). All compile on stable rustc 1.94.1
  with no C toolchain. (See §5 deviation box: `keyring` vs `tauri-plugin-stronghold`.)
- **Proxy sidecar (§6): no new Rust crates** — reuses the existing
  `tauri-plugin-shell`. Added `bundle.externalBin: ["binaries/litellm-proxy"]`,
  scoped `shell:allow-execute` + `shell:allow-spawn` in `capabilities/default.json`,
  and a compiled mock at `binaries/litellm-proxy-x86_64-pc-windows-msvc.exe`
  (source `binaries/litellm-proxy-mock.rs`). `generate_context!()` validates the
  externalBin for the host triple at compile time, so the mock must exist for
  `cargo check` to pass.
- **Image pipeline (§7): `reqwest 0.12`** added with `default-features = false` +
  `["json","rustls-tls"]` — keeps us off OpenSSL/native-tls on Windows (rustls uses
  `ring`, already linked by the SSE host). No other new crates (`base64`/`serde_json`
  reused). Stage-1/2 endpoints are loopback HTTP (Ollama/ComfyUI) + HTTPS (Ideogram).
- Bundle icons generated under `src-tauri/icons/` (embedded by
  `generate_context!()` at compile time).
- **Windows note:** stdio servers backed by npm tools must be registered with
  the `.cmd` shim (e.g. `command: "npx.cmd"`), because `CreateProcess` does not
  apply `PATHEXT` to the program name.

---

## 12. Build & run

```bash
# Frontend only (design in a normal browser; __TAURI__ absent → IPC mocks/no-ops)
npm install
npm run dev            # http://localhost:3000
npm run build          # static export to ./dist  (verified passing)

# Full desktop app (requires the Rust toolchain + Tauri prerequisites)
npm run tauri:dev
npm run tauri:build

# Database migrations (authoring)
npm run db:generate    # schema.ts -> src-tauri/migrations/*.sql
```

> `tauri.conf.json` references bundle icons under `src-tauri/icons/`. Generate
> them once with `npm run tauri icon <path-to-logo.png>` before
> `tauri:build`.
