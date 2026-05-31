//! Typed IPC command surface — the ONLY boundary the frontend may cross.
//!
//! SCAFFOLDING PHASE: signatures are final, bodies are placeholders. Keeping the
//! shapes here lets the TypeScript side (`src/lib/ipc.ts`) be authored against a
//! stable contract before the subsystems are implemented.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::mcp::host::{HostInfo, HostState};
use crate::mcp::{McpRouter, Transport};
use crate::memory::MemoryHandle;

// ─── DTOs shared with the frontend (mirror src/db/schema.ts) ────────────────

#[derive(Serialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
}

#[derive(Deserialize)]
pub struct NewMessage {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
}

/// One persisted timeline turn, returned when a session is reopened.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct McpServerDto {
    pub id: String,
    pub name: String,
    pub transport: String, // "stdio" | "sse" | "http"
    pub command: Option<String>,
    /// Argv for stdio transport (e.g. ["-y", "@modelcontextprotocol/server-everything"]).
    /// Mirrors `mcp_servers.args` in schema.ts; absent for sse/http.
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct ToolResult {
    pub ok: bool,
    pub content: serde_json::Value,
}

// ─── Memory (encrypted libsql via Rust) ─────────────────────────────────────

#[tauri::command]
pub async fn list_conversations(
    db: tauri::State<'_, MemoryHandle>,
) -> Result<Vec<Conversation>, String> {
    let rows = db.list_conversations()?;
    Ok(rows
        .into_iter()
        .map(|(id, title)| Conversation { id, title })
        .collect())
}

/// Start a new session. Returns the freshly-minted conversation so the UI can
/// select it immediately (the title is refined from the first user message).
#[tauri::command]
pub async fn create_conversation(
    title: Option<String>,
    db: tauri::State<'_, MemoryHandle>,
) -> Result<Conversation, String> {
    let (id, title) = db.create_conversation(title.as_deref().unwrap_or("New chat"))?;
    Ok(Conversation { id, title })
}

/// Persist one turn (user prompt / assistant answer / tool run). Returns the new id.
#[tauri::command]
pub async fn append_message(
    msg: NewMessage,
    db: tauri::State<'_, MemoryHandle>,
) -> Result<String, String> {
    db.append_message(&msg.conversation_id, &msg.role, &msg.content)
}

/// Reopen a session: every stored turn, oldest first, for the timeline to replay.
#[tauri::command]
pub async fn list_messages(
    conversation_id: String,
    db: tauri::State<'_, MemoryHandle>,
) -> Result<Vec<StoredMessage>, String> {
    let rows = db.list_messages(&conversation_id)?;
    Ok(rows
        .into_iter()
        .map(|(id, role, content)| StoredMessage { id, role, content })
        .collect())
}

// ─── SQL bridge (Drizzle sqlite-proxy ⇆ rusqlite) ───────────────────────────
//
// The frontend's Drizzle adapter (src/lib/db.ts) hands us its generated SQL +
// bound params + method. `run` statements go to `execute_sql`; read methods
// (`all`/`get`/`values`) go to `query_sql`, which returns POSITIONAL value rows
// for Drizzle to map back onto the selected columns.
//
// SECURITY: this is a broader surface than the semantic commands — the webview
// can run arbitrary single statements against the local DB. Plaintext provider
// keys still never cross IPC (only sealed ciphertext is stored, §5), and each
// call executes exactly one statement. See §4/§11.

#[tauri::command]
pub async fn execute_sql(
    query: String,
    params: Vec<serde_json::Value>,
    db: tauri::State<'_, MemoryHandle>,
) -> Result<serde_json::Value, String> {
    let (rows_affected, last_insert_rowid) = db.execute(&query, &params)?;
    Ok(serde_json::json!({
        "rowsAffected": rows_affected,
        "lastInsertRowid": last_insert_rowid,
    }))
}

#[tauri::command]
pub async fn query_sql(
    query: String,
    params: Vec<serde_json::Value>,
    db: tauri::State<'_, MemoryHandle>,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    db.query(&query, &params)
}

// ─── MCP engine (multi-transport routing) ───────────────────────────────────

#[tauri::command]
pub async fn list_mcp_servers(
    router: tauri::State<'_, Arc<McpRouter>>,
) -> Result<Vec<McpServerDto>, String> {
    // Registry is the in-process source of truth until memory/ (§4) persists it.
    Ok(router.list_servers().await)
}

#[tauri::command]
pub async fn register_mcp_server(
    server: McpServerDto,
    router: tauri::State<'_, Arc<McpRouter>>,
) -> Result<(), String> {
    let transport = Transport::from_dto(&server)?;
    let id = server.id.clone();

    // stdio is wired this milestone: bring the session up FIRST and only record
    // the server once it's live, so a failed launch never leaves a ghost entry.
    // sse/http have no live session yet (§3.1), so we just record their metadata.
    match transport {
        Transport::Stdio { .. } => {
            router.connect(&id, transport).await?;
            router.remember(server).await;
        }
        _ => router.remember(server).await,
    }
    Ok(())
}

#[tauri::command]
pub async fn list_mcp_tools(router: tauri::State<'_, Arc<McpRouter>>) -> Result<ToolResult, String> {
    // Aggregated across all live sessions; tools are namespaced `server::tool`.
    // Per-server failures are reported in `content.errors`, not as a hard error.
    let content = router.list_tools().await?;
    Ok(ToolResult { ok: true, content })
}

#[tauri::command]
pub async fn call_mcp_tool(
    server_id: String,
    tool: String,
    args: serde_json::Value,
    router: tauri::State<'_, Arc<McpRouter>>,
) -> Result<ToolResult, String> {
    let content = router.call_tool(&server_id, &tool, args).await?;
    // MCP signals tool-level failure via `isError` inside an otherwise-OK result.
    let ok = !content
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(ToolResult { ok, content })
}

#[tauri::command]
pub async fn mcp_host_info(
    host: tauri::State<'_, Arc<HostState>>,
) -> Result<Option<HostInfo>, String> {
    // The loopback URL of the axum MCP host (so the UI can hand it to web apps).
    Ok(host.info().await)
}

// ─── Crypto boundary (BYOK secret sealing, §5) ──────────────────────────────
//
// The ONLY way plaintext secrets are turned into / recovered from ciphertext. The
// master key lives in the OS keychain inside `CryptoState` and never crosses this
// boundary — the front end receives sealed strings only. Registration flow: the
// UI seals the typed key here, then writes the returned ciphertext to `api_keys`
// via the Drizzle proxy; `unseal_data` is used only to verify the round-trip.

#[tauri::command]
pub async fn seal_data(
    plaintext: String,
    crypto: tauri::State<'_, crate::crypto::CryptoState>,
) -> Result<String, String> {
    crypto.seal(&plaintext)
}

#[tauri::command]
pub async fn unseal_data(
    ciphertext: String,
    crypto: tauri::State<'_, crate::crypto::CryptoState>,
) -> Result<String, String> {
    crypto.unseal(&ciphertext)
}

// ─── BYOK (encrypted secrets + LiteLLM proxy) ───────────────────────────────

#[tauri::command]
pub async fn store_api_key(_provider: String, _secret: String) -> Result<(), String> {
    // Superseded by the seal_data + Drizzle-write path (the front end seals via
    // `seal_data` then persists the ciphertext to `api_keys`). Kept reserved for a
    // future server-side convenience wrapper (§6 proxy wiring).
    Err("not implemented: use seal_data + Drizzle write (see §5)".into())
}

/// Start args: the front end passes the SEALED ciphertext (read from `api_keys`),
/// never plaintext. The backend unseals it with the Phase 5 crypto layer and
/// injects the key into the sidecar's env — so plaintext never crosses IPC (§5/§6).
#[derive(Deserialize)]
pub struct StartProxyArgs {
    pub provider: String,
    /// `api_keys.secret_ciphertext` for the chosen provider, or null to run keyless.
    pub ciphertext: Option<String>,
    pub model: Option<String>,
    pub port: Option<u16>,
}

#[tauri::command]
pub async fn start_byok_proxy(
    args: StartProxyArgs,
    app: tauri::AppHandle,
    proxy: tauri::State<'_, crate::proxy::ProxyState>,
    crypto: tauri::State<'_, crate::crypto::CryptoState>,
) -> Result<crate::proxy::ProxyStatus, String> {
    // Unseal in-process (the master key stays in the OS keychain); the plaintext
    // lives only here and is handed to the supervisor for env injection.
    let api_key = match &args.ciphertext {
        Some(ct) => Some(crypto.unseal(ct)?),
        None => None,
    };
    let params = crate::proxy::StartParams {
        provider: args.provider,
        model: args.model,
        port: args.port.unwrap_or(crate::proxy::DEFAULT_PORT),
        api_key,
    };
    proxy.start(&app, params)
}

#[tauri::command]
pub async fn stop_byok_proxy(
    proxy: tauri::State<'_, crate::proxy::ProxyState>,
) -> Result<crate::proxy::ProxyStatus, String> {
    proxy.stop()
}

#[tauri::command]
pub async fn get_proxy_status(
    proxy: tauri::State<'_, crate::proxy::ProxyState>,
) -> Result<crate::proxy::ProxyStatus, String> {
    Ok(proxy.status())
}

// ─── Image pipeline (two-stage) ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ImageRequest {
    pub prompt: String,
    /// Hint forcing a route; otherwise the router decides FLUX vs Ideogram.
    pub force_route: Option<String>,
}

/// Two-stage pipeline (§7): Stage 1 expands + classifies the prompt via local
/// `qwen3-vl`; Stage 2 routes to local FLUX.1-schnell (standard) or the Ideogram
/// API (typography-heavy). The Ideogram key is read sealed from the BYOK DB and
/// unsealed **here** (§5) — plaintext never crosses IPC. Every external hop
/// degrades to a placeholder, so this always returns `Ok` (see image/mod.rs).
#[tauri::command]
pub async fn generate_image(
    req: ImageRequest,
    db: tauri::State<'_, MemoryHandle>,
    crypto: tauri::State<'_, crate::crypto::CryptoState>,
) -> Result<crate::image::ImageResult, String> {
    // Best-effort: fetch + unseal the stored Ideogram key for the typography route.
    // Used only if the router picks Ideogram; absent/failed → the pipeline falls
    // back to a placeholder. The plaintext stays in this process.
    let ideogram_key = crate::orchestrator::lookup_secret(db.inner(), crypto.inner(), "ideogram");
    Ok(crate::image::generate(&req.prompt, req.force_route.as_deref(), ideogram_key).await)
}

// ─── Conversational orchestrator (direct multi-provider agentic loop) ───────
//
// Plain-English turns from the composer land here, then run through the shared
// `orchestrator::run_turn` core — the SAME path the Remote Control socket handler
// uses (Phase 4), so a phone-driven turn is byte-identical to a local one. This
// command's only job is to map the typed IPC args into `TurnParams` and reach the
// managed states via `tauri::State`. `/image` and explicit `server::tool`
// invocations are handled on the frontend and never reach here.

/// A user-attached image from the composer. `data` is base64 (no `data:` prefix).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
}

#[tauri::command]
pub async fn submit_chat_message(
    user_prompt: String,
    provider: Option<String>,
    model: Option<String>,
    session_id: Option<String>,
    images: Option<Vec<ImageInput>>,
    router: tauri::State<'_, Arc<McpRouter>>,
    db: tauri::State<'_, MemoryHandle>,
    crypto: tauri::State<'_, crate::crypto::CryptoState>,
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<crate::orchestrator::ChatResult, String> {
    // Keep copies for the Remote Control mirror (the params move below).
    let mirror_session = session_id.clone();
    let mirror_prompt = user_prompt.clone();
    let params = crate::orchestrator::TurnParams {
        user_prompt,
        provider,
        model,
        session_id,
        // Map the composer's image DTOs into the orchestrator's (media_type, base64) shape.
        images: images
            .unwrap_or_default()
            .into_iter()
            .map(|i| (i.media_type, i.data))
            .collect(),
    };
    let result = crate::orchestrator::run_turn(router.inner(), db.inner(), crypto.inner(), params).await?;
    // Mirror this desktop-typed turn to a paired phone (no-op when not connected or
    // the turn isn't in the shared session), so both timelines stay in sync.
    remote.broadcast_turn(
        mirror_session.as_deref(),
        &mirror_prompt,
        &result.text,
        &result.tools_used,
        &result.images,
    );
    Ok(result)
}

// ─── Overlay (web-app hover button summon) ──────────────────────────────────

#[tauri::command]
pub async fn summon_overlay(_origin: String) -> Result<(), String> {
    // TODO(overlay): validate origin against allow-list, show/focus overlay window.
    Err("not implemented: overlay::summon".into())
}

// ─── Remote Control (E2E pairing, §Phase 3) ─────────────────────────────────
//
// `remote_start_pairing` mints a fresh ephemeral AES-256 key + pairing id in the
// Rust crypto layer and returns the `trenlens://pair` QR payload. Only the
// base64url key string crosses IPC — and only so the webview can draw the QR; the
// raw key never leaves the backend, and the phone receives it by scanning, not via
// IPC. Calling again rotates the key (invalidating any previously shown QR). The
// WebSocket connect/disconnect commands that consume this session land in Phase 4.

#[tauri::command]
pub async fn remote_start_pairing(
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<crate::remote::PairingInfo, String> {
    Ok(remote.start_pairing())
}

// ─── Remote Control (live relay connection, §Phase 4) ───────────────────────
//
// The desktop authenticates the WebSocket with the SAME Supabase JWT the frontend
// already holds (the relay verifies it at the upgrade, §3.1), so the token is passed
// in from the webview rather than minted in Rust. `remote_connect` spawns the
// headless background client for the armed pairing; `remote_update_token` pushes a
// refreshed token before the ~1h expiry (used on the next reconnect);
// `remote_disconnect` stops the client AND drops the E2E key (re-pair to reconnect);
// `remote_status` polls state (the panel also gets pushed `remote://status` events).

#[tauri::command]
pub async fn remote_connect(
    jwt: String,
    relay_url: Option<String>,
    app: tauri::AppHandle,
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<crate::remote::RemoteStatus, String> {
    remote.connect(&app, jwt, relay_url)
}

#[tauri::command]
pub async fn remote_update_token(
    jwt: String,
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<(), String> {
    remote.update_token(jwt)
}

#[tauri::command]
pub async fn remote_disconnect(
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<crate::remote::RemoteStatus, String> {
    Ok(remote.disconnect())
}

#[tauri::command]
pub async fn remote_status(
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<crate::remote::RemoteStatus, String> {
    Ok(remote.status())
}

// ─── Remote Control (live two-way timeline sync, §Phase 6) ──────────────────
//
// The desktop's active conversation IS the shared session the phone mirrors. The UI
// calls this whenever that conversation changes (and on connect): it binds the id so
// a desktop turn under it is broadcast to the phone, then pushes that conversation's
// stored timeline so the phone backfills and adopts the same id (its next turn then
// lands in the same conversation). `null` clears the binding. Phone-driven turns flow
// the other way via the `remote://turn` event the Rust client emits.

#[tauri::command]
pub async fn remote_set_conversation(
    session_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    db: tauri::State<'_, MemoryHandle>,
    remote: tauri::State<'_, crate::remote::RemoteState>,
) -> Result<(), String> {
    // Always record the desktop's selected engine so phone turns adopt it. Push the
    // timeline ONLY when the bound conversation actually changes (connect / chat
    // switch) — a mere provider/model change must not re-sync the phone's timeline.
    let changed = remote.bound_session().as_deref() != session_id.as_deref();
    remote.set_bound_session(session_id.clone());
    remote.set_bound_model(provider, model);
    if changed {
        if let Some(cid) = &session_id {
            // Only user/assistant turns replay (tool/image rows are skipped, matching
            // the orchestrator's history filter), as (role, content) pairs oldest-first.
            let turns: Vec<(String, String)> = db
                .list_messages(cid)?
                .into_iter()
                .filter(|(_, role, _)| role == "user" || role == "assistant")
                .map(|(_, role, content)| (role, content))
                .collect();
            remote.push_history(cid, turns);
        }
    }
    Ok(())
}
