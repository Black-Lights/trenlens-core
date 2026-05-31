# Changelog

All notable changes to TrenLens Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0-alpha.2]: https://github.com/Black-Lights/trenlens-core/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Black-Lights/trenlens-core/releases/tag/v0.1.0-alpha.1
