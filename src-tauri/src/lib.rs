//! trenlens-core — Tauri v2 host process.
//!
//! This file wires the IPC surface and plugins. The heavy subsystems live in
//! sibling modules and are intentionally STUBBED for the scaffolding phase:
//!   - `mcp`    multi-transport MCP engine (stdio + axum SSE)  — see mcp/mod.rs
//!   - `memory` encrypted libsql store                          — see memory/mod.rs
//!   - `proxy`  local LiteLLM BYOK proxy supervisor             — see proxy/mod.rs
//!   - `crypto` AES-GCM sealing for BYOK secrets                — see crypto/mod.rs
//!
//! Each `#[tauri::command]` is the typed contract the Next.js frontend calls via
//! `window.__TAURI__.invoke`. Bodies return `todo!()`/placeholder values so the
//! IPC shape is committed now without locking in an implementation.

mod commands;
mod crypto;
mod image;
mod mcp;
mod memory;
mod orchestrator;
mod proxy;
mod remote;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::sync::Arc;
    use tauri::Manager;

    // The router is shared between the IPC commands (frontend) and the axum host
    // (web apps), so both see ONE aggregated registry of stdio + remote tools.
    let router = Arc::new(mcp::McpRouter::new());
    let host_state = Arc::new(mcp::host::HostState::default());

    let router_for_host = router.clone();
    let host_for_host = host_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // In-app auto-update: signed manifest check + download/install, then relaunch.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(router)
        .manage(host_state)
        // BYOK proxy supervisor — initialised at startup, ready to spawn on the
        // user's toggle (§6). We do NOT auto-spawn: a keyless proxy is pointless,
        // and spawning is gated on the user picking a provider + sealed key.
        .manage(proxy::ProxyState::default())
        // Remote Control (§Phase 3): holds the armed E2E pairing session (ephemeral
        // AES key + room id). No socket is opened until the user enables it (Phase 4).
        .manage(remote::RemoteState::default())
        .setup(move |app| {
            // Open the local DB (sole owner = Rust) and apply migrations, then
            // hand the connection to the SQL-bridge commands via managed state.
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            std::fs::create_dir_all(&dir)?;
            let db = memory::MemoryHandle::open(&dir.join("trenlens.db"))
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(db);

            // Unlock the crypto vault: load-or-create the 32-byte master key from
            // the OS keychain (§5). `seal_data`/`unseal_data` delegate to this; the
            // key never crosses IPC. Generated on first launch only.
            let vault = crypto::CryptoState::init()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(vault);

            // Run the axum MCP host alongside the app so cooperating web apps can
            // reach the aggregated tool registry over loopback (§3.1, §7).
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::host::serve(router_for_host, host_for_host).await {
                    eprintln!("[mcp::host] server exited: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_conversations,
            commands::create_conversation,
            commands::append_message,
            commands::delete_conversation,
            commands::list_messages,
            commands::execute_sql,
            commands::query_sql,
            commands::list_mcp_servers,
            commands::register_mcp_server,
            commands::list_mcp_tools,
            commands::call_mcp_tool,
            commands::mcp_host_info,
            commands::seal_data,
            commands::unseal_data,
            commands::store_api_key,
            commands::start_byok_proxy,
            commands::stop_byok_proxy,
            commands::get_proxy_status,
            commands::generate_image,
            commands::submit_chat_message,
            commands::summon_overlay,
            commands::remote_start_pairing,
            commands::remote_connect,
            commands::remote_update_token,
            commands::remote_disconnect,
            commands::remote_status,
            commands::remote_set_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running trenlens-core");
}
