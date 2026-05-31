# TrenLens Core

A cross-platform, **local-first desktop AI assistant** that orchestrates any tool,
web app, or CLI over the **Model Context Protocol (MCP)** — with a bring-your-own-key
conversational layer, a fluid timeline UI, and an everything-stays-on-your-machine
security model.

**Stack:** Tauri v2 (Rust host) · Next.js (App Router, static export) · TypeScript ·
Drizzle ORM (over IPC) · Framer Motion · next-themes.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

> Active development. The desktop engine compiles, unit-tests, and builds clean.
> Live provider calls (Anthropic / DeepSeek / Kimi) and remote tools run with your
> own API keys; everything degrades gracefully when a dependency is offline.

## Features

- **MCP orchestration.** Connect local stdio MCP servers from inside the app (no
  config file, no restart). Their tools land on a single live registry and are
  namespaced `server::tool`.
- **Conversational, multi-provider LLM with tool use.** Plain English is routed to
  your selected provider/model; the model can call any connected MCP tool in an
  agentic loop (implemented for both Anthropic `tool_use` and OpenAI-compatible
  `tool_calls`). Providers: **Anthropic** (Sonnet 4.6 / Opus 4.8 / Haiku 4.5),
  **DeepSeek** (v4-flash / v4-pro), **Kimi / Moonshot** (k2.5 / k2.6), each with a
  relative cost badge.
- **Conversation history.** Sessions persist to a local SQLite database and reopen
  intact across restarts. New sessions are auto-named by the model from the first
  message (generated concurrently with the answer, so it adds no latency), and can be
  deleted from the History sidebar.
- **Remote Control — drive your desktop from your phone.** An end-to-end encrypted
  *authenticated blind relay* lets an installable mobile PWA control the local
  engine: Supabase (ES256) identity, a Cloudflare Worker + Durable Object relay that
  only ever forwards opaque ciphertext, and AES-256-GCM E2E with QR/link pairing. The
  conversation syncs live in both directions — type on the phone or the desktop and
  it appears (and answers) on both. See **[DEPLOYMENT.md](./DEPLOYMENT.md)** to put it
  online with your own Supabase + Cloudflare accounts.
- **BYOK, sealed locally.** Provider keys are encrypted with AES-256-GCM; the master
  key lives in your OS keychain and never crosses to the UI or touches the DB file.
  The panel shows at a glance which providers have a key sealed.
- **Two-stage image pipeline.** A prompt-expansion stage (local Ollama) routes to a
  local FLUX/ComfyUI render or the Ideogram API, degrading to a placeholder offline.
- **Markdown answers + Typographic Unblur.** Replies stream in with a per-character
  unblur, then settle into rendered Markdown (headings, lists, tables, code).
- **Fluid dual-theme UI.** A continuous timeline spine, breathing "Morphing Node"
  tool indicators, and a token-driven light/dark theme.

## Security model

- Plaintext secrets **never cross the IPC boundary** to the webview. Keys are sealed
  and unsealed only on the Rust side; the master key is held in the native OS vault
  (Windows Credential Manager / macOS Keychain / Linux Secret Service).
- The Rust process is the **sole owner** of the local database file; the frontend
  reaches it only through a typed, single-statement SQL bridge.
- The local databases and any `.env` files are git-ignored and stay in your app-data
  directory, never the repository.

## Layout

```
trenlens-core/
├─ RESEARCH_AND_GUIDELINES.md   # architecture spec
├─ PROGRESS_TRACKER.md          # build log / phase status
├─ REMOTE_ARCHITECTURE_PLAN.md  # Remote Control design (the blind-relay architecture)
├─ DEPLOYMENT.md                # production deployment playbook (Supabase + Cloudflare)
├─ src/                          # Next.js frontend
│  ├─ app/                       # layout, page, globals.css (theme tokens)
│  ├─ components/
│  │  ├─ timeline/               # Timeline, MorphingNode, UnblurText, Markdown
│  │  ├─ chat/                   # Composer, ConnectionBar
│  │  ├─ config/                 # ServerSidebar (BYOK + tools), HistorySidebar, ConfirmDialog
│  │  └─ remote/                 # RemotePairing (sign-in → QR → live status)
│  ├─ db/schema.ts               # Drizzle schema
│  └─ lib/                       # ipc.ts bridge, useMcp.ts controller, models.ts, remote.ts
├─ src-tauri/                    # Rust host
│  └─ src/{lib,commands}.rs      # plugin wiring + typed IPC surface
│  └─ src/{mcp,memory,crypto,proxy,image,orchestrator,remote}/  # subsystems
├─ relay/                        # Cloudflare Worker + Durable Object blind relay
└─ mobile/                       # mobile PWA (Next.js static export → Cloudflare Pages)
```

## Develop

Prerequisites: Node.js ≥ 20, and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
(Rust toolchain + platform webview deps) for the desktop build.

```bash
npm install
npm run dev          # browser preview at http://localhost:3000 (IPC mocked)
npm run build        # static export -> ./dist
npm run tauri:dev    # full desktop app (needs the Rust toolchain)
```

The browser preview runs without Rust: when `window.__TAURI__` is absent, the IPC
layer degrades to mocks so the UI/animation work is fully designable in a browser.

### Connect an MCP server

Launch the desktop app, open the **Servers** panel (gear icon, top-right) → **Add a
local server** → set the Command and Arguments → **Connect (stdio)**. On Windows,
npm-based servers must use the `npx.cmd` shim, e.g.:

- Command: `npx.cmd`
- Arguments: `-y @modelcontextprotocol/server-everything`

Then add a provider API key under **Provider key (BYOK)**, pick a model, and chat.

## License

Licensed under the [Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for
attribution.
