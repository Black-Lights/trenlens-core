# TrenLens Core — v0.1.0-alpha.4

**Drive your desktop from your phone — end-to-end encrypted, over a relay that can't read a word of it.**

This release lands **Remote Control**: a complete phone-controls-desktop pipeline built on an
_Authenticated Blind Relay_, plus live two-way conversation sync, hardened mobile pairing, and a
polished desktop chat-management pass. It is the largest architectural addition since the initial
alpha.

---

## Headline: the zero-knowledge blind relay

A phone now drives your local TrenLens engine from anywhere on the internet — and the server in the
middle is **deliberately blind**. The architecture has four independently-secured layers:

1. **Identity — Supabase, ES256/JWKS.** Both devices sign in to the same account. Tokens are signed
   with an **asymmetric ES256** key; the relay holds only the *public* JWKS and can therefore
   *verify* a token but never *mint* one. No shared secret ever touches the edge.
2. **Transport — Cloudflare Worker + Durable Object.** The Worker authenticates the WebSocket
   upgrade (JWT/room/role ride as `Sec-WebSocket-Protocol` tokens, since browsers can't set WS
   headers), then routes to a per-pairing Durable Object addressed by `idFromName(${user_id}:${pairingId})`
   — that addressing *is* the pairing. Policy: **1 desktop + N phones**, newest desktop wins.
3. **Confidentiality — AES-256-GCM, end-to-end.** Every application message is sealed into an
   `{iv, ct}` envelope **before** it touches the socket. The relay forwards opaque ciphertext and
   learns nothing but frame size and timing. The Rust (`aes-gcm`) and browser (WebCrypto) codecs are
   **byte-for-byte identical**, proven against a shared conformance vector.
4. **Pairing — QR or link.** The desktop mints an ephemeral 32-byte key + room id and renders a
   `trenlens://pair?room=…&key=…` QR. The key **only ever appears in the QR** — it never crosses IPC,
   never hits the relay, and is held in memory only (a hard reload re-pairs). Disconnecting drops the
   key (re-scan to reconnect).

> **What the relay can see:** that two authenticated sockets of the same account are connected, and
> the size/timing of opaque frames. **What it cannot see:** any message content, ever.

---

## What's new

### Added
- **Remote Control (phones → desktop).** Headless Rust WebSocket client on the desktop pipes
  decrypted commands through the *same* `orchestrator::run_turn` a local turn uses — so a remote turn
  is byte-identical to a local one (same provider resolution, same history, same persistence). An
  installable **mobile PWA** (Next.js static export on Cloudflare Pages) is the controller.
- **Live two-way timeline sync.** The desktop's active conversation is the shared session. Type on
  the phone and it appears + answers on the desktop; type on the desktop and it mirrors to the phone
  — one shared, persisted conversation. Switching chats on the desktop re-syncs the phone (history
  backfill + session adoption).
- **Camera-optional pairing.** The mobile pairing screen no longer dead-ends when the camera is
  denied (common on iOS standalone PWAs): the camera starts on a tap, a **paste-the-link** path is
  always available, and denials surface a friendly, actionable message instead of a broken box.
- **Delete chats (desktop).** Per-chat delete in the History sidebar, backed by a **styled in-app
  confirmation dialog** — replacing the browser's native `window.confirm`.
- **Production deployment playbook (`DEPLOYMENT.md`).** Supabase ES256 setup, Cloudflare Worker +
  Pages deploys, and the exact env wiring for both desktop and mobile.

### Changed
- **Remote turns honor the desktop's engine.** A phone turn (which sends no provider/model) now runs
  on the provider/model selected on the desktop — Anthropic / DeepSeek / Kimi — not just the default.

### Fixed
- **Cloudflare relay handshake.** The desktop's Rust client now synthesizes a complete upgrade
  request (`Sec-WebSocket-Key`, `Connection`, `Upgrade`, …) via `IntoClientRequest`, so it passes the
  relay handshake instead of failing with a missing-header protocol error.

---

## Security posture

- Plaintext secrets and the E2E key **never cross the IPC boundary**; the AES key lives in memory
  only and is rendered solely into the QR.
- The relay is **verify-only** — it holds the public JWKS, never a Supabase secret or service-role key.
- The Supabase **anon/publishable** key shipped in the clients is public by design.
- `.env.local`, `supabase/signing_keys.json`, and the updater private key remain git-ignored and out
  of the repo.

---

## Verification

- Rust: `cargo build` warning-free; remote-module unit tests pass (seal/open round-trips, foreign-key
  fail-closed, camelCase wire shapes, provider classification).
- Web: `tsc` clean for desktop and mobile (incl. an explicit unused-locals/params pass); mobile
  static export builds; relay typechecks.
- End-to-end: verified phone-on-cellular → Cloudflare relay → desktop, both timelines mirroring, with
  the deployed Worker + Pages.

---

## Upgrading / release follow-up

This release bumps the app to **0.1.0-alpha.4** (`appInfo.ts`, `package.json`, `tauri.conf.json`,
`mobile/package.json`). The signed installer + `latest.json` are produced separately per
[`RELEASING.md`](./RELEASING.md):

1. Build signed: `TAURI_SIGNING_PRIVATE_KEY=… npm run tauri:build`.
2. `gh release create v0.1.0-alpha.4 --prerelease` and upload the `*-setup.exe`.
3. Copy [`latest.alpha4.json`](./latest.alpha4.json) → `latest.json`, drop in the real `signature`
   (contents of `*-setup.exe.sig`) and the asset URL, commit to `main`.

Until then the live `latest.json` intentionally still points at the signed **alpha.3** build, so
auto-updates for current installs keep working.
