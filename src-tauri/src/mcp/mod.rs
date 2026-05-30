//! MCP engine — multi-transport router.
//!
//! The Rust core is an **MCP host**: it maintains one live client session per
//! registered server and routes `tools/list` / `tools/call` to the right
//! transport. This milestone implements the **stdio** transport end to end on
//! top of `rust-mcp-sdk`; `sse` / `http` return an explicit "not yet" error so
//! the contract is honest about what is wired.
//!
//!   transport = "stdio" → spawn a local child process, speak JSON-RPC over its
//!                          stdin/stdout (rust-mcp-sdk's StdioTransport).
//!   transport = "sse"    → connect to / host a Server-Sent-Events stream (TODO).
//!   transport = "http"   → stateless JSON-RPC POST (TODO).
//!
//! See RESEARCH_AND_GUIDELINES.md §3.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::RwLock;

use rust_mcp_sdk::{
    mcp_client::{client_runtime, ClientHandler, ClientRuntime, McpClientOptions},
    schema::{CallToolRequestParams, CallToolResult, InitializeRequestParams, Tool},
    ClientStreamableTransport, McpClient, RequestOptions, StdioTransport, StreamableTransportOptions,
    ToMcpClientHandler, TransportOptions,
};

use crate::commands::McpServerDto;

/// The inbound axum MCP host (re-exposes this router's aggregated registry).
pub mod host;

/// One registered upstream server and its chosen transport.
pub enum Transport {
    Stdio { command: String, args: Vec<String> },
    Sse { url: String },
    Http { url: String },
}

impl Transport {
    /// Build a transport from the IPC DTO, validating required fields.
    pub fn from_dto(dto: &McpServerDto) -> Result<Self, String> {
        match dto.transport.as_str() {
            "stdio" => {
                let command = dto
                    .command
                    .clone()
                    .filter(|c| !c.trim().is_empty())
                    .ok_or("stdio transport requires a `command`")?;
                Ok(Transport::Stdio {
                    command,
                    args: dto.args.clone().unwrap_or_default(),
                })
            }
            "sse" => Ok(Transport::Sse {
                url: dto.url.clone().ok_or("sse transport requires a `url`")?,
            }),
            "http" => Ok(Transport::Http {
                url: dto.url.clone().ok_or("http transport requires a `url`")?,
            }),
            other => Err(format!("unknown transport: {other}")),
        }
    }
}

/// Minimal client handler. The default `ClientHandler` impls cover initialize
/// negotiation, ping, and server-initiated notifications, which is all the host
/// needs for a request/response tool-calling workload.
struct HostClientHandler;

#[async_trait]
impl ClientHandler for HostClientHandler {}

/// Owns every active session plus the registry of known servers. Lives in Tauri
/// managed state (`.manage(McpRouter::new())`).
///
/// Until the encrypted `memory/` store is implemented (§4), the registry is the
/// in-process source of truth for `list_mcp_servers`; persistence is layered in
/// later without changing this surface.
pub struct McpRouter {
    sessions: RwLock<HashMap<String, Arc<ClientRuntime>>>,
    registry: RwLock<HashMap<String, McpServerDto>>,
}

impl McpRouter {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            registry: RwLock::new(HashMap::new()),
        }
    }

    /// Record a server in the registry (so it shows up in `list_mcp_servers`),
    /// independent of whether a live session could be established.
    pub async fn remember(&self, dto: McpServerDto) {
        self.registry.write().await.insert(dto.id.clone(), dto);
    }

    /// Servers known to the host, newest registration order not guaranteed.
    pub async fn list_servers(&self) -> Vec<McpServerDto> {
        self.registry.read().await.values().cloned().collect()
    }

    /// Establish (or replace) a session for `server_id` over `transport`.
    pub async fn connect(&self, server_id: &str, transport: Transport) -> Result<(), String> {
        match transport {
            Transport::Stdio { command, args } => {
                // Replace any existing session for this id so re-registering a
                // server never orphans the previous child process.
                let _ = self.disconnect(server_id).await;

                let client_details = initialize_params()?;

                // `create_with_server_launch` spawns the child and wires JSON-RPC
                // over its stdin/stdout. `.as_str()` keeps us compatible whether
                // the SDK takes `&str` or `impl Into<String>`.
                let stdio = StdioTransport::create_with_server_launch(
                    command.as_str(),
                    args,
                    None,
                    TransportOptions::default(),
                )
                .map_err(|e| format!("spawning stdio MCP server `{command}`: {e}"))?;

                // 0.9 takes a single options struct; `ClientHandler` is bridged to
                // the internal `McpClientHandler` via `to_mcp_client_handler()`.
                let client = client_runtime::create_client(McpClientOptions {
                    client_details,
                    transport: stdio,
                    handler: HostClientHandler.to_mcp_client_handler(),
                    task_store: None,
                    server_task_store: None,
                    message_observer: None,
                });
                client
                    .clone()
                    .start()
                    .await
                    .map_err(|e| format!("starting MCP session for `{server_id}`: {e}"))?;

                self.sessions
                    .write()
                    .await
                    .insert(server_id.to_string(), client);
                Ok(())
            }
            // Both remote variants ride Streamable HTTP — modern MCP folds the
            // SSE stream into the streamable endpoint (server→client frames are
            // delivered as SSE), so a remote web app's tools land in the same map.
            Transport::Sse { url } | Transport::Http { url } => {
                self.connect_streamable(server_id, &url).await
            }
        }
    }

    /// Connect to a remote MCP server / web app over Streamable HTTP and register
    /// it as a session, so its tools merge into the unified registry.
    async fn connect_streamable(&self, server_id: &str, url: &str) -> Result<(), String> {
        let _ = self.disconnect(server_id).await;
        let client_details = initialize_params()?;
        let options = StreamableTransportOptions {
            mcp_url: url.to_string(),
            request_options: RequestOptions::default(),
        };
        let transport = ClientStreamableTransport::new(&options, None, false)
            .map_err(|e| format!("creating streamable transport to `{url}`: {e}"))?;
        let client = client_runtime::create_client(McpClientOptions {
            client_details,
            transport,
            handler: HostClientHandler.to_mcp_client_handler(),
            task_store: None,
            server_task_store: None,
            message_observer: None,
        });
        client
            .clone()
            .start()
            .await
            .map_err(|e| format!("starting remote MCP session for `{server_id}`: {e}"))?;
        self.sessions.write().await.insert(server_id.to_string(), client);
        Ok(())
    }

    /// Tear down a session if one exists (best effort).
    pub async fn disconnect(&self, server_id: &str) -> Result<(), String> {
        let client = self.sessions.write().await.remove(server_id);
        if let Some(client) = client {
            client
                .shut_down()
                .await
                .map_err(|e| format!("shutting down `{server_id}`: {e}"))?;
        }
        Ok(())
    }

    /// Fan out `tools/list` across all live sessions, returning `(server_id, tool)`
    /// pairs plus any per-server errors. A failing/crashed server is isolated
    /// into `errors` rather than failing the whole aggregation. The lock is not
    /// held across the network awaits.
    async fn gather(&self) -> (Vec<(String, Tool)>, Vec<Value>) {
        let snapshot: Vec<(String, Arc<ClientRuntime>)> = {
            let sessions = self.sessions.read().await;
            sessions.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };

        let mut pairs: Vec<(String, Tool)> = Vec::new();
        let mut errors: Vec<Value> = Vec::new();
        for (server_id, client) in snapshot {
            match client.request_tool_list(None).await {
                Ok(list) => {
                    for tool in list.tools {
                        pairs.push((server_id.clone(), tool));
                    }
                }
                Err(e) => errors.push(json!({ "server": server_id, "error": e.to_string() })),
            }
        }
        (pairs, errors)
    }

    /// Aggregated tools as the JSON the FRONTEND consumes: each tool keeps its
    /// bare `name` and gains `server` + `qualifiedName` (`server::tool`). Source
    /// is transport-agnostic — stdio and remote (sse/http) tools look identical.
    pub async fn list_tools(&self) -> Result<Value, String> {
        let (pairs, errors) = self.gather().await;
        let mut tools_out: Vec<Value> = Vec::with_capacity(pairs.len());
        for (server_id, tool) in pairs {
            let mut v = serde_json::to_value(&tool).map_err(|e| e.to_string())?;
            if let Value::Object(ref mut map) = v {
                let bare = map.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string();
                map.insert("server".into(), Value::String(server_id.clone()));
                map.insert("qualifiedName".into(), Value::String(format!("{server_id}::{bare}")));
            }
            tools_out.push(v);
        }
        Ok(json!({ "tools": tools_out, "errors": errors }))
    }

    /// Aggregated tools as typed `Tool`s for the axum HOST to re-expose: each
    /// tool's `name` is rewritten to its `server::tool` qualified form so an
    /// incoming `tools/call` can be routed back to the owning session.
    pub async fn aggregate_tools(&self) -> Result<Vec<Tool>, String> {
        let (pairs, _errors) = self.gather().await;
        Ok(pairs
            .into_iter()
            .map(|(server_id, mut tool)| {
                tool.name = format!("{server_id}::{}", tool.name);
                tool
            })
            .collect())
    }

    /// Dispatch a single `tools/call` to the owning session, returning the typed
    /// MCP `CallToolResult` (used by the axum host to relay results downstream).
    pub async fn call_tool_typed(
        &self,
        server_id: &str,
        tool: &str,
        args: Value,
    ) -> Result<CallToolResult, String> {
        let client = {
            let sessions = self.sessions.read().await;
            sessions
                .get(server_id)
                .cloned()
                .ok_or_else(|| format!("no live MCP session for server `{server_id}`"))?
        };

        // Build params via the wire shape so we don't couple to the struct's
        // exact field set: `arguments` is `Option<Map<String,Value>>`, so a JSON
        // object → Some(map) and null → None; anything else is rejected.
        let params: CallToolRequestParams = serde_json::from_value(json!({
            "name": tool,
            "arguments": args,
        }))
        .map_err(|e| format!("invalid arguments for tool `{tool}`: {e}"))?;

        client
            .request_tool_call(params)
            .await
            .map_err(|e| format!("tools/call `{tool}` on `{server_id}`: {e}"))
    }

    /// Same as `call_tool_typed`, serialized to JSON for the IPC/command layer.
    pub async fn call_tool(&self, server_id: &str, tool: &str, args: Value) -> Result<Value, String> {
        let result = self.call_tool_typed(server_id, tool, args).await?;
        serde_json::to_value(result).map_err(|e| e.to_string())
    }
}

impl Default for McpRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// The host's `initialize` parameters, built through the wire format to stay
/// resilient to minor schema field additions across SDK point releases.
fn initialize_params() -> Result<InitializeRequestParams, String> {
    serde_json::from_value(json!({
        "capabilities": {},
        "clientInfo": {
            "name": "trenlens-core",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "protocolVersion": "2025-11-25",
    }))
    .map_err(|e| format!("building initialize params: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end stdio round-trip against a real MCP server. Ignored by default
    /// because it spawns `npx @modelcontextprotocol/server-everything` (needs
    /// Node + network on first run). Run explicitly with:
    ///   cargo test -p trenlens-core stdio_roundtrip -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn stdio_roundtrip_against_server_everything() {
        // On Windows, npm ships `npx.cmd`; bare `npx` won't be found by CreateProcess.
        let command = if cfg!(windows) { "npx.cmd" } else { "npx" };

        let router = McpRouter::new();
        router
            .connect(
                "everything",
                Transport::Stdio {
                    command: command.into(),
                    args: vec![
                        "-y".into(),
                        "@modelcontextprotocol/server-everything".into(),
                    ],
                },
            )
            .await
            .expect("connect stdio MCP server");

        let listed = router.list_tools().await.expect("list_tools");
        let tools = listed["tools"].as_array().expect("tools array");
        assert!(!tools.is_empty(), "expected at least one tool");

        // Pin the exact shape the frontend's parseTools() reads.
        let echo = tools
            .iter()
            .find(|t| t["name"] == "echo")
            .expect("server-everything exposes an `echo` tool");
        assert_eq!(echo["server"], "everything");
        assert_eq!(echo["qualifiedName"], "everything::echo");
        assert!(
            echo.get("inputSchema").or_else(|| echo.get("input_schema")).is_some(),
            "tool must carry an input schema for the palette/scaffold"
        );
        eprintln!("[list_tools] echo = {}", serde_json::to_string_pretty(echo).unwrap());

        // server-everything's `echo` returns its input. Pin the result envelope
        // the frontend's renderToolContent() / `isError` flag depend on.
        let result = router
            .call_tool("everything", "echo", json!({ "message": "trenlens" }))
            .await
            .expect("call_tool echo");
        let block0 = &result["content"][0];
        assert_eq!(block0["type"], "text", "first content block is text");
        assert!(
            block0["text"].as_str().unwrap_or_default().contains("trenlens"),
            "echo should round-trip the message: {result}"
        );
        assert!(!result["isError"].as_bool().unwrap_or(false), "echo is not an error");
        eprintln!("[call_tool] result = {}", serde_json::to_string_pretty(&result).unwrap());

        router.disconnect("everything").await.ok();
    }
}
