//! Inbound axum-based MCP host (§3.1b).
//!
//! Runs in the background alongside the Tauri app, bound to loopback, and
//! re-exposes the host's **aggregated** tool registry (the very same
//! [`McpRouter`] that owns the stdio + remote sessions) to cooperating web apps
//! over MCP. Two surfaces are served by the SDK's hyper server:
//!   - Streamable HTTP at `/mcp` (current MCP transport)
//!   - SSE at `/sse` + `/messages` (backward-compatible)
//!
//! Because `tools/list` / `tools/call` here delegate straight into the shared
//! `McpRouter`, a web app that connects sees local (`stdio`) and remote (`sse`/
//! `http`) tools through ONE endpoint — exactly the unified view the Next.js
//! frontend gets from `list_mcp_tools`.
//!
//! Security (§7/§10): bound to `127.0.0.1` with DNS-rebinding protection and a
//! strict `allowed_origins` allow-list so only approved web-app origins (plus
//! loopback) may reach it. TLS is intentionally off — this is a loopback peer.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use rust_mcp_sdk::{
    mcp_server::{hyper_server, HyperServerOptions, ServerHandler},
    schema::{
        CallToolError, CallToolRequestParams, CallToolResult, InitializeResult, ListToolsResult,
        PaginatedRequestParams, RpcError,
    },
    McpServer, ToMcpServerHandler,
};

use super::McpRouter;

/// Where the host server is reachable. Surfaced to the UI via `mcp_host_info`
/// so it can hand a loopback URL to cooperating web apps.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub port: u16,
    pub mcp_url: String,
    pub sse_url: String,
}

/// Tauri-managed handle to the running host (its bound address once started).
#[derive(Default)]
pub struct HostState {
    info: tokio::sync::RwLock<Option<HostInfo>>,
}

impl HostState {
    pub async fn info(&self) -> Option<HostInfo> {
        self.info.read().await.clone()
    }
}

/// Origins permitted to reach the loopback host — strict, mirroring §7's overlay
/// allow-list. With `dns_rebinding_protection` on, the SDK rejects any request
/// whose `Origin` isn't listed. Loopback origins are included so local pages and
/// the host's own tooling work out of the box.
fn allowed_origins(port: u16) -> Vec<String> {
    vec![
        "https://trenlens.com".to_string(),
        "https://app.trenlens.com".to_string(),
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ]
}

/// The host's advertised identity + capabilities (it serves tools).
fn server_details() -> Result<InitializeResult, String> {
    serde_json::from_value(json!({
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "trenlens-core", "version": env!("CARGO_PKG_VERSION") },
        "protocolVersion": "2025-11-25",
        "instructions": "TrenLens Core aggregated MCP host. Tools are namespaced `server::tool`.",
    }))
    .map_err(|e| format!("building host server details: {e}"))
}

/// Grab a free loopback port up front so we can surface a deterministic URL
/// before the server task takes over (small TOCTOU window, fine on loopback).
fn free_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.local_addr().map_err(|e| e.to_string()).map(|a| a.port())
}

/// Run the host until the process exits. Binds `127.0.0.1:<ephemeral>` and
/// serves the SHARED `router`'s aggregated tools.
pub async fn serve(router: Arc<McpRouter>, state: Arc<HostState>) -> Result<(), String> {
    let port = free_loopback_port()?;

    let options = HyperServerOptions {
        host: "127.0.0.1".to_string(),
        port,
        // §7/§10 — strict origin validation for the remote web-app surface.
        dns_rebinding_protection: true,
        allowed_origins: Some(allowed_origins(port)),
        allowed_hosts: Some(vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")]),
        ..Default::default()
    };

    let handler = HostServerHandler { router }.to_mcp_server_handler();
    let server = hyper_server::create_server(server_details()?, handler, options);

    *state.info.write().await = Some(HostInfo {
        port,
        mcp_url: format!("http://127.0.0.1:{port}/mcp"),
        sse_url: format!("http://127.0.0.1:{port}/sse"),
    });

    server.start().await.map_err(|e| format!("hyper MCP host: {e}"))
}

/// Bridges incoming MCP requests to the shared router. `tools/list` reflects the
/// aggregated, namespaced registry; `tools/call` splits the `server::tool` name
/// and routes back to the owning session.
struct HostServerHandler {
    router: Arc<McpRouter>,
}

#[async_trait]
impl ServerHandler for HostServerHandler {
    async fn handle_list_tools_request(
        &self,
        _params: Option<PaginatedRequestParams>,
        _runtime: Arc<dyn McpServer>,
    ) -> Result<ListToolsResult, RpcError> {
        let tools = self
            .router
            .aggregate_tools()
            .await
            .map_err(|e| RpcError::internal_error().with_message(e))?;
        let tools_value = serde_json::to_value(tools)
            .map_err(|e| RpcError::internal_error().with_message(e.to_string()))?;
        serde_json::from_value(json!({ "tools": tools_value }))
            .map_err(|e| RpcError::internal_error().with_message(e.to_string()))
    }

    async fn handle_call_tool_request(
        &self,
        params: CallToolRequestParams,
        _runtime: Arc<dyn McpServer>,
    ) -> Result<CallToolResult, CallToolError> {
        let (server, tool) = params.name.split_once("::").ok_or_else(|| {
            CallToolError::from_message(format!(
                "tool name must be namespaced as `server::tool`, got `{}`",
                params.name
            ))
        })?;
        let args = match params.arguments {
            Some(map) => Value::Object(map),
            None => Value::Null,
        };
        self.router
            .call_tool_typed(server, tool, args)
            .await
            .map_err(|e| CallToolError::from_message(e))
    }
}
