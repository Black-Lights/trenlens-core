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
    let ideogram_key = lookup_secret(db.inner(), crypto.inner(), "ideogram");
    Ok(crate::image::generate(&req.prompt, req.force_route.as_deref(), ideogram_key).await)
}

/// Read the latest sealed secret for `provider` from `api_keys` and unseal it
/// in-process. Returns `None` on any miss/decrypt failure so callers degrade
/// gracefully (e.g. the placeholder probe row never unseals to a real key).
fn lookup_secret(
    db: &MemoryHandle,
    crypto: &crate::crypto::CryptoState,
    provider: &str,
) -> Option<String> {
    let rows = db
        .query(
            "SELECT secret_ciphertext FROM api_keys WHERE provider = ?1 ORDER BY created_at DESC LIMIT 1",
            &[serde_json::Value::String(provider.to_string())],
        )
        .ok()?;
    let ciphertext = rows.first()?.first()?.as_str()?;
    crypto.unseal(ciphertext).ok()
}

// ─── Conversational orchestrator (direct multi-provider agentic loop) ───────
//
// Plain-English turns from the composer land here. We resolve the active provider
// (anthropic | deepseek | kimi), fetch that provider's sealed key from `api_keys`,
// unseal it in-process (§5 — plaintext never crosses IPC), load the session's
// prior turns for context, and hand it all to the orchestrator, which declares the
// connected MCP tools to the model and runs the tool-call loop. The user prompt and
// the assistant's answer are persisted under `session_id` so they survive a restart.
// `/image` and explicit `server::tool` invocations are handled on the frontend and
// never reach here.

/// How many prior (user/assistant) turns to replay as context — bounds the prompt.
const HISTORY_TURNS: usize = 20;

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
) -> Result<crate::orchestrator::ChatResult, String> {
    let provider = provider
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "anthropic".to_string());
    let model = model.unwrap_or_default();
    let images: Vec<crate::orchestrator::ImageInput> = images
        .unwrap_or_default()
        .into_iter()
        .map(|i| (i.media_type, i.data))
        .collect();

    // The api_keys.provider string is the same id selected in the BYOK panel.
    let api_key = lookup_secret(db.inner(), crypto.inner(), &provider).ok_or_else(|| {
        format!("No {provider} key found. Add one in the BYOK panel (provider: {provider}) and try again.")
    })?;

    // Replay prior user/assistant turns for multi-turn context (tool/image rows
    // are skipped — the model gets the conversation, not raw tool payloads).
    let history: Vec<crate::orchestrator::Turn> = match &session_id {
        Some(sid) => {
            let mut turns: Vec<crate::orchestrator::Turn> = db
                .list_messages(sid)?
                .into_iter()
                .filter(|(_, role, _)| role == "user" || role == "assistant")
                .map(|(_, role, content)| (role, content))
                .collect();
            if turns.len() > HISTORY_TURNS {
                turns = turns.split_off(turns.len() - HISTORY_TURNS);
            }
            turns
        }
        None => Vec::new(),
    };

    // On the first turn of a session, ask the model to name the chat from the
    // user's opening message — run CONCURRENTLY with the answer (it only needs the
    // prompt), so it overlaps the longer chat turn and adds no perceptible latency.
    let first_turn = history.is_empty() && session_id.is_some();
    let chat_fut = crate::orchestrator::run_chat(
        router.inner(),
        &provider,
        &api_key,
        &model,
        &history,
        &user_prompt,
        &images,
    );
    let title_fut = async {
        if first_turn {
            crate::orchestrator::generate_title(&provider, &api_key, &model, &user_prompt).await
        } else {
            None
        }
    };
    let (result, title) = tokio::join!(chat_fut, title_fut);
    let result = result?;

    // Persist the round-trip so the session reloads intact (best-effort — a
    // storage hiccup must not sink an otherwise-successful answer).
    if let Some(sid) = &session_id {
        let _ = db.append_message(sid, "user", &user_prompt);
        let _ = db.append_message(sid, "assistant", &result.text);
        // LLM title wins over the first-message snippet set by append_message.
        if let Some(title) = title {
            let _ = db.set_conversation_title(sid, &title);
        }
    }

    Ok(result)
}

// ─── Overlay (web-app hover button summon) ──────────────────────────────────

#[tauri::command]
pub async fn summon_overlay(_origin: String) -> Result<(), String> {
    // TODO(overlay): validate origin against allow-list, show/focus overlay window.
    Err("not implemented: overlay::summon".into())
}
