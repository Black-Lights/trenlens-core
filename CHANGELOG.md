# Changelog

All notable changes to TrenLens Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha.4] - 2026-05-31

### Added
- **Remote Control — drive your desktop from your phone.** An end-to-end encrypted
  "authenticated blind relay" lets a phone control the local TrenLens engine:
  Supabase (ES256 / JWKS) identity, a Cloudflare Worker + Durable Object relay that
  only ever forwards opaque ciphertext, AES-256-GCM E2E with QR/link pairing, a
  headless Rust WebSocket client on the desktop, and an installable mobile PWA. Sign
  in on both devices with the same account, pair, and chat. See `DEPLOYMENT.md`.
- **Live two-way timeline sync.** The desktop's active conversation is mirrored to
  the phone and back — type on either side and it appears (and answers) on both, in
  one shared, persisted conversation. Switching chats on the desktop re-syncs the
  phone.
- **Camera-optional pairing.** The mobile pairing screen no longer dead-ends when the
  camera is denied (common on iOS): the camera starts on a tap, and a paste-the-link
  path is always available (desktop **Copy link** → paste on the phone), with
  friendly messages for blocked/missing cameras.
- **Delete chats.** The desktop History sidebar now has a per-chat delete with a
  styled in-app confirmation popup (replacing the native browser dialog).
- **`DEPLOYMENT.md`** — a step-by-step production deployment playbook (Supabase ES256
  keys, Cloudflare Worker + Pages, env setup for desktop and mobile).

### Changed
- **Remote turns honor the desktop's engine.** A phone turn (which sends no
  provider/model) now runs on the provider/model selected on the desktop — not just
  the Anthropic default — so it works across Anthropic / DeepSeek / Kimi.

### Fixed
- **Cloudflare relay handshake.** The desktop's Rust WebSocket client now synthesizes
  a complete upgrade request (`Sec-WebSocket-Key`, etc.) so it passes the relay
  handshake instead of failing with a missing-header protocol error.

## [0.1.0-alpha.3] - 2026-05-31

### Fixed
- **Tool screenshots now display.** Browser-screenshot tools (e.g. Playwright MCP)
  only return an image inline when called *without* a filename — otherwise they
  just save a file to disk. The assistant is now told that TrenLens renders tool
  images inline and to capture screenshots without a filename, so "show me a
  screenshot" actually shows one instead of pointing at a file path.

### Changed
- **Vision parity for Kimi & DeepSeek.** Images produced by tools are now fed back
  to OpenAI-compatible models as a follow-up user turn (the OpenAI `tool` role
  can't carry images), so vision-capable Kimi/DeepSeek models can see screenshots
  the same way Anthropic already does. Attached-image input was already supported
  for these providers.

## [0.1.0-alpha.2] - 2026-05-31

### Added
- **Image attachments (vision).** Attach images in the composer; they're sent to
  the active model as native image content (Anthropic image blocks / OpenAI-style
  `image_url`) so you can ask about screenshots, diagrams, etc.
- **Images render in chat.** User attachments, tool-result images (e.g. browser
  screenshots from MCP tools), and Markdown image links now display inline with the
  Typographic Unblur reveal. Anthropic tool results also feed images back to the
  model so it can actually see them.
- **CHANGELOG.md** (this file).

### Changed
- **Live Markdown rendering.** Assistant replies now render formatted Markdown
  *while streaming* — headings, lists, tables, **bold**, and `code` — instead of
  showing raw `.md` syntax that snapped to formatted at the end.
- **Auto-expanding composer.** The input grows with multi-line text (up to a cap,
  then scrolls) instead of staying a single fixed-height line.

## [0.1.0-alpha.1] - 2026-05-31

### Added
- Initial public alpha.
- **MCP orchestration** — connect local stdio MCP servers in-app (no config file,
  no restart); tools land on one live registry (`server::tool`).
- **Multi-provider conversational layer (BYOK)** with an agentic tool-use loop —
  Anthropic (Sonnet 4.6 / Opus 4.8 / Haiku 4.5), DeepSeek (v4-flash / v4-pro),
  Kimi / Moonshot (k2.5 / k2.6), each with a relative cost badge.
- **Conversation history** persisted to local SQLite; sessions reopen across
  restarts and are auto-named by the model from the first message.
- **BYOK keys sealed locally** (AES-256-GCM; master key in the OS keychain) with an
  at-a-glance "available to chat" indicator.
- **Two-stage image pipeline** (Ollama prompt expansion → local FLUX/ComfyUI or
  Ideogram) with graceful offline placeholders.
- **In-app auto-updater** (signed `tauri-plugin-updater`) with a "Check for updates"
  action in the About dialog.
- **About dialog** with version, developer, license, and update controls.
- **Apache-2.0** license; signed NSIS installer published to GitHub Releases.

[0.1.0-alpha.4]: https://github.com/Black-Lights/trenlens-core/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/Black-Lights/trenlens-core/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/Black-Lights/trenlens-core/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Black-Lights/trenlens-core/releases/tag/v0.1.0-alpha.1
