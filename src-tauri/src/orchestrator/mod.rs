//! Conversational orchestrator — the direct API agentic loop (Option A),
//! now multi-provider.
//!
//! Turns plain English into a tool-using assistant turn:
//!   1. Gather every connected MCP tool from the live `McpRouter` once
//!      (`collect_tools`) and declare them to the model in its native format —
//!      Anthropic `tools` or OpenAI `tools:[{type:function,...}]`. Names are
//!      sanitised `server::tool` → `server__tool` with a reverse map back to the
//!      owning session.
//!   2. POST to the provider endpoint over HTTPS (`reqwest`/`rustls-tls`):
//!        • anthropic            → api.anthropic.com/v1/messages
//!        • deepseek             → api.deepseek.com/v1/chat/completions
//!        • kimi (moonshot)      → api.moonshot.cn/v1/chat/completions
//!   3. If the model asks to use a tool, execute each via `McpRouter::call_tool`,
//!      feed the result back, and loop until it produces prose (bounded by
//!      `MAX_TOOL_ITERS`, with a forced tool-free closing turn).
//!
//! Secrets (§5): the provider key is unsealed in the **command layer** and passed
//! in as plaintext that lives only in this process — it never crosses IPC and is
//! never logged. The HTTP turns are non-streamed because the agentic loop needs
//! the complete tool-call blocks before acting; the UI "streams" the final answer
//! via the frontend `UnblurText` word-chunk animation (identical visible effect).

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::mcp::McpRouter;

// ── Endpoints ────────────────────────────────────────────────────────────────
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEEPSEEK_URL: &str = "https://api.deepseek.com/v1/chat/completions";
// The user specified the mainland (.cn) host; the international gateway is
// api.moonshot.ai. Both speak the same OpenAI-compatible schema.
const KIMI_URL: &str = "https://api.moonshot.cn/v1/chat/completions";

// ── Per-provider default models (used only when the UI sends no explicit model) ─
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
const DEFAULT_KIMI_MODEL: &str = "kimi-k2.5";

const MAX_TOKENS: u32 = 2048;
/// Safety bound on the tool-use loop so a misbehaving model can't spin forever.
const MAX_TOOL_ITERS: usize = 6;

// Compact but app-accurate. The "About this app" block is what stops the model
// from giving generic Claude-Desktop advice (edit mcp.json / restart) — TrenLens
// has neither. Kept terse on purpose; the dominant per-call token cost is the tool
// schemas + replayed history, not this prompt.
const SYSTEM_PROMPT: &str = "You are TrenLens, a local desktop app (built with Tauri) that lets the \
user orchestrate tools over the Model Context Protocol (MCP). Use the user's connected MCP tools \
when they help answer or act; otherwise answer directly. Be concise and natural, use Markdown for \
structure, and never invent tool results.\n\n\
About this app, so your guidance is correct (it has NO mcp.json file and needs NO restart — never \
tell the user to edit a config file or restart):\n\
- Add an MCP server in-app: open the Servers panel (gear icon, top-right) -> \"Add a local server\" \
-> set Command and Arguments -> Connect (stdio); it connects live. On Windows, npm-based servers \
must use the npx.cmd shim, e.g. Command `npx.cmd`, Arguments `-y @modelcontextprotocol/server-everything`.\n\
- Run a connected tool directly by typing `server::tool {\"json\":\"args\"}`, or just ask in plain \
English and you'll call the tools yourself.\n\
- `/image <prompt>` runs the built-in image pipeline.\n\
- TrenLens renders images inline in the chat: any image a tool returns (e.g. a browser screenshot) \
and any image you generate are shown to the user automatically. Never tell the user you \"can't \
display\" an image or to open a file on disk. IMPORTANT: when the user wants to SEE a screenshot, \
call the screenshot tool WITHOUT a filename/path argument — that makes the tool return the image \
inline (which TrenLens shows). Passing a filename makes some tools only save a file to disk, so the \
user sees nothing.\n\
- API keys (Anthropic, DeepSeek, Kimi, ...) and the chat model are set in that same panel under \
\"Provider key (BYOK)\"; keys are sealed locally and never leave the device. Past chats live in the \
left History sidebar (+ New chat starts a session).";

/// IPC return: the assistant's final text plus the (display) names of any tools it
/// invoked along the way, so the UI can note them under the answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub text: String,
    pub tools_used: Vec<String>,
    /// `data:` URIs of any images produced by tools during the turn (e.g. a browser
    /// screenshot), so the UI can render them under the answer.
    pub images: Vec<String>,
}

/// One prior turn loaded from local history, as `(role, content)` — only `user`
/// and `assistant` rows are forwarded for context (tool/image rows are skipped).
pub type Turn = (String, String);

/// A user-attached image: `(media_type, base64_data)` — base64 has no `data:` prefix.
pub type ImageInput = (String, String);

/// Run one conversational turn end-to-end (may span several round-trips while the
/// model calls tools). `api_key` is already-unsealed plaintext; `model` empty →
/// the provider default; `history` is prior (role, content) turns, oldest first;
/// `images` are user-attached images sent with this turn (vision).
pub async fn run_chat(
    router: &McpRouter,
    provider: &str,
    api_key: &str,
    model: &str,
    history: &[Turn],
    user_prompt: &str,
    images: &[ImageInput],
) -> Result<ChatResult, String> {
    let client = build_client()?;
    let catalog = collect_tools(router).await;

    match provider.trim().to_ascii_lowercase().as_str() {
        "deepseek" => {
            run_openai(&client, router, DEEPSEEK_URL, api_key, pick(model, DEFAULT_DEEPSEEK_MODEL), &catalog, history, user_prompt, images).await
        }
        "kimi" | "moonshot" => {
            run_openai(&client, router, KIMI_URL, api_key, pick(model, DEFAULT_KIMI_MODEL), &catalog, history, user_prompt, images).await
        }
        // anthropic (and any unknown provider) → the native Messages API loop.
        _ => {
            run_anthropic(&client, router, api_key, pick(model, DEFAULT_ANTHROPIC_MODEL), &catalog, history, user_prompt, images).await
        }
    }
}

// ── LLM-generated conversation titles ───────────────────────────────────────

const TITLE_SYSTEM: &str = "You write a short chat title (3 to 6 words) summarising the user's \
request. Use Title Case. Output ONLY the title — no quotes, no trailing punctuation, no preamble.";

/// Ask the active model for a concise title based on the conversation's first
/// message. Best-effort and dependency-free: it only needs the user prompt, so
/// the caller runs it concurrently with the main turn (`tokio::join!`) — it adds
/// no perceptible latency. Returns `None` on any error so the caller keeps its
/// fallback (a snippet of the first message).
pub async fn generate_title(provider: &str, api_key: &str, model: &str, first_message: &str) -> Option<String> {
    let client = build_client().ok()?;
    let snippet: String = first_message.chars().take(600).collect();
    let raw = match provider.trim().to_ascii_lowercase().as_str() {
        "deepseek" => {
            title_openai(&client, DEEPSEEK_URL, api_key, pick(model, DEFAULT_DEEPSEEK_MODEL), &snippet).await?
        }
        "kimi" | "moonshot" => {
            title_openai(&client, KIMI_URL, api_key, pick(model, DEFAULT_KIMI_MODEL), &snippet).await?
        }
        _ => title_anthropic(&client, api_key, pick(model, DEFAULT_ANTHROPIC_MODEL), &snippet).await?,
    };
    let cleaned = clean_title(&raw);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

async fn title_anthropic(client: &reqwest::Client, api_key: &str, model: &str, user: &str) -> Option<String> {
    let body = json!({
        "model": model,
        "max_tokens": 24,
        "system": TITLE_SYSTEM,
        "messages": [{ "role": "user", "content": user }],
    });
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let t = extract_anthropic_text(&v);
    (!t.is_empty()).then_some(t)
}

async fn title_openai(client: &reqwest::Client, url: &str, api_key: &str, model: &str, user: &str) -> Option<String> {
    let body = json!({
        "model": model,
        "max_tokens": 24,
        "messages": [
            { "role": "system", "content": TITLE_SYSTEM },
            { "role": "user", "content": user },
        ],
    });
    let resp = client
        .post(url)
        .header("authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    let t = v
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?
        .trim()
        .to_string();
    (!t.is_empty()).then_some(t)
}

/// Normalise a model-produced title: first line only, strip wrapping quotes /
/// markdown / trailing punctuation, clamp length.
fn clean_title(raw: &str) -> String {
    let first = raw.lines().next().unwrap_or(raw);
    // Strip wrapping/trailing quotes, markdown, and punctuation from both ends.
    let strip = |c: char| matches!(c, '"' | '\'' | '`' | '*' | '#' | '.' | ':' | '—' | '-') || c.is_whitespace();
    let stripped = first.trim_matches(strip);
    if stripped.chars().count() > 60 {
        let mut s: String = stripped.chars().take(57).collect();
        s.push('…');
        s
    } else {
        stripped.to_string()
    }
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("building HTTP client: {e}"))
}

/// The selected model, or the provider default when the UI sent nothing.
fn pick<'a>(model: &'a str, default: &'a str) -> &'a str {
    if model.trim().is_empty() {
        default
    } else {
        model.trim()
    }
}

// ── Anthropic Messages API path ──────────────────────────────────────────────

async fn run_anthropic(
    client: &reqwest::Client,
    router: &McpRouter,
    api_key: &str,
    model: &str,
    catalog: &ToolCatalog,
    history: &[Turn],
    user_prompt: &str,
    images: &[ImageInput],
) -> Result<ChatResult, String> {
    let decls = catalog.anthropic_decls();
    let tools_opt = if decls.is_empty() { None } else { Some(decls.as_slice()) };

    // Prior turns carry plain-string content (Anthropic accepts that); the new
    // user prompt is appended last (as a content array when images are attached).
    let mut messages: Vec<Value> = history
        .iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect();
    messages.push(json!({ "role": "user", "content": anthropic_user_content(user_prompt, images) }));
    let mut tools_used: Vec<String> = Vec::new();
    let mut images_out: Vec<String> = Vec::new();

    for _ in 0..MAX_TOOL_ITERS {
        let resp = call_anthropic(client, api_key, model, &messages, tools_opt).await?;
        let content = resp.get("content").cloned().unwrap_or_else(|| json!([]));
        let blocks = content.as_array().cloned().unwrap_or_default();

        let mut text_out = String::new();
        let mut calls: Vec<(String, String, Value)> = Vec::new(); // (id, sanitised_name, input)
        for b in &blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        text_out.push_str(t);
                    }
                }
                Some("tool_use") => calls.push((
                    b.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                    b.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    b.get("input").cloned().unwrap_or_else(|| json!({})),
                )),
                _ => {}
            }
        }

        if calls.is_empty() {
            return Ok(ChatResult { text: text_out.trim().to_string(), tools_used, images: images_out });
        }

        // Echo the assistant turn back verbatim (Anthropic requires the original
        // tool_use blocks in the transcript), then answer each with a tool_result.
        messages.push(json!({ "role": "assistant", "content": content }));
        let mut tool_results: Vec<Value> = Vec::with_capacity(calls.len());
        for (id, sanitised, input) in calls {
            let block = match catalog.resolver.get(&sanitised) {
                Some((server, tool)) => {
                    tools_used.push(tool.clone());
                    match router.call_tool(server, tool, input).await {
                        Ok(result) => {
                            let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
                            // Build a content array carrying any image blocks so the
                            // model can actually see screenshots, and surface those
                            // images to the UI too.
                            let (content, uris) = anthropic_tool_result_content(&result);
                            images_out.extend(uris);
                            json!({
                                "type": "tool_result",
                                "tool_use_id": id,
                                "content": content,
                                "is_error": is_error,
                            })
                        }
                        Err(e) => json!({
                            "type": "tool_result", "tool_use_id": id,
                            "content": format!("Tool execution failed: {e}"), "is_error": true,
                        }),
                    }
                }
                None => json!({
                    "type": "tool_result", "tool_use_id": id,
                    "content": format!("Unknown tool: {sanitised}"), "is_error": true,
                }),
            };
            tool_results.push(block);
        }
        messages.push(json!({ "role": "user", "content": tool_results }));
    }

    // Loop exhausted: force a tool-free closing turn so the user always gets prose.
    let resp = call_anthropic(client, api_key, model, &messages, None).await?;
    let text = extract_anthropic_text(&resp);
    Ok(ChatResult {
        text: if text.is_empty() {
            format!("(stopped after {MAX_TOOL_ITERS} tool steps without a final answer)")
        } else {
            text
        },
        tools_used,
        images: images_out,
    })
}

/// One Anthropic call. Parsed message object on 2xx; otherwise the API's
/// `error.message` (or a truncated body) as `Err`.
async fn call_anthropic(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
) -> Result<Value, String> {
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    });
    if let Some(t) = tools {
        body["tools"] = json!(t);
    }

    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {}", net_err(&e)))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("reading Anthropic response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Anthropic API error {}: {}", status.as_u16(), api_error_message(&raw)));
    }
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parsing Anthropic response: {e}"))
}

/// Concatenate the text blocks of an Anthropic message object.
fn extract_anthropic_text(resp: &Value) -> String {
    resp.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ── OpenAI-compatible path (DeepSeek, Kimi/Moonshot) ─────────────────────────

async fn run_openai(
    client: &reqwest::Client,
    router: &McpRouter,
    url: &str,
    api_key: &str,
    model: &str,
    catalog: &ToolCatalog,
    history: &[Turn],
    user_prompt: &str,
    images: &[ImageInput],
) -> Result<ChatResult, String> {
    let decls = catalog.openai_decls();
    let tools_opt = if decls.is_empty() { None } else { Some(decls.as_slice()) };

    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 2);
    messages.push(json!({ "role": "system", "content": SYSTEM_PROMPT }));
    for (role, content) in history {
        messages.push(json!({ "role": role, "content": content }));
    }
    messages.push(json!({ "role": "user", "content": openai_user_content(user_prompt, images) }));
    let mut tools_used: Vec<String> = Vec::new();
    let mut images_out: Vec<String> = Vec::new();

    for _ in 0..MAX_TOOL_ITERS {
        let resp = call_openai(client, url, api_key, model, &messages, tools_opt).await?;
        let message = resp
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let text = message.get("content").and_then(Value::as_str).unwrap_or("").to_string();
        let tool_calls = message.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();

        if tool_calls.is_empty() {
            return Ok(ChatResult { text: text.trim().to_string(), tools_used, images: images_out });
        }

        // The assistant message that requested the calls MUST precede the tool
        // results; echo it back verbatim, then answer each call with a tool msg.
        messages.push(message.clone());
        let mut turn_images: Vec<(String, String)> = Vec::new();
        for tc in &tool_calls {
            let id = tc.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let func = tc.get("function");
            let fname = func.and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or_default().to_string();
            let args_str = func.and_then(|f| f.get("arguments")).and_then(Value::as_str).unwrap_or("{}");
            let input: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));

            let content = match catalog.resolver.get(&fname) {
                Some((server, tool)) => {
                    tools_used.push(tool.clone());
                    match router.call_tool(server, tool, input).await {
                        Ok(result) => {
                            // OpenAI `tool` messages are text-only; collect any tool
                            // images so we can both surface them to the UI and feed
                            // them back to the model (as a follow-up user turn below).
                            let imgs = collect_tool_images(&result);
                            for (mime, data) in &imgs {
                                images_out.push(data_uri(mime, data));
                            }
                            turn_images.extend(imgs);
                            flatten_tool_result(&result)
                        }
                        Err(e) => format!("Tool execution failed: {e}"),
                    }
                }
                None => format!("Unknown tool: {fname}"),
            };
            messages.push(json!({ "role": "tool", "tool_call_id": id, "content": content }));
        }

        // OpenAI's `tool` role can't carry image parts, so re-present any
        // tool-produced images as a follow-up user turn. This gives vision-capable
        // OpenAI-compatible providers (Kimi, DeepSeek) the same screenshot
        // awareness the Anthropic path gets via image blocks in tool_result.
        if !turn_images.is_empty() {
            messages.push(json!({ "role": "user", "content": openai_image_followup(&turn_images) }));
        }
    }

    let resp = call_openai(client, url, api_key, model, &messages, None).await?;
    let text = resp
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(ChatResult {
        text: if text.is_empty() {
            format!("(stopped after {MAX_TOOL_ITERS} tool steps without a final answer)")
        } else {
            text
        },
        tools_used,
        images: images_out,
    })
}

/// One OpenAI-compatible chat-completions call (`Authorization: Bearer`).
async fn call_openai(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
) -> Result<Value, String> {
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": messages,
    });
    if let Some(t) = tools {
        body["tools"] = json!(t);
        body["tool_choice"] = json!("auto");
    }

    let resp = client
        .post(url)
        .header("authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Provider request failed: {}", net_err(&e)))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("reading provider response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Provider API error {}: {}", status.as_u16(), api_error_message(&raw)));
    }
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parsing provider response: {e}"))
}

// ── Tool catalogue (shared across providers) ─────────────────────────────────

/// The live MCP tools, resolved once per turn: a reverse map (sanitised name →
/// owning `(server_id, tool_name)`) plus the raw `(name, description, schema)`
/// triples each provider formats into its own declaration shape.
struct ToolCatalog {
    resolver: HashMap<String, (String, String)>,
    items: Vec<(String, String, Value)>, // (sanitised_name, description, input_schema)
}

impl ToolCatalog {
    /// Anthropic `tools`: `{ name, description, input_schema }`.
    fn anthropic_decls(&self) -> Vec<Value> {
        self.items
            .iter()
            .map(|(name, desc, schema)| {
                json!({ "name": name, "description": desc, "input_schema": normalize_schema(schema.clone()) })
            })
            .collect()
    }

    /// OpenAI `tools`: `{ type:"function", function:{ name, description, parameters } }`.
    fn openai_decls(&self) -> Vec<Value> {
        self.items
            .iter()
            .map(|(name, desc, schema)| {
                json!({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": desc,
                        "parameters": normalize_schema(schema.clone()),
                    }
                })
            })
            .collect()
    }
}

/// Gather the live MCP tools into a provider-agnostic catalogue. Best-effort: on
/// any router error we return an empty catalogue (the model simply answers
/// without tools).
async fn collect_tools(router: &McpRouter) -> ToolCatalog {
    let listed = match router.list_tools().await {
        Ok(v) => v,
        Err(_) => return ToolCatalog { resolver: HashMap::new(), items: Vec::new() },
    };
    let arr = listed.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut resolver = HashMap::new();
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for t in arr {
        let server = t.get("server").and_then(Value::as_str).unwrap_or_default().to_string();
        let name = t.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        if server.is_empty() || name.is_empty() {
            continue;
        }
        let sanitised = unique_sanitised(&format!("{server}::{name}"), &mut seen);
        let schema = t
            .get("inputSchema")
            .or_else(|| t.get("input_schema"))
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        let description = t.get("description").and_then(Value::as_str).unwrap_or("").to_string();
        items.push((sanitised.clone(), description, schema));
        resolver.insert(sanitised, (server, name));
    }
    ToolCatalog { resolver, items }
}

/// Tool names must match `^[a-zA-Z0-9_-]{1,64}$` (true for both Anthropic and
/// OpenAI). Map `::` → `__`, drop any other illegal char to `_`, clamp to 64.
fn sanitise(qualified: &str) -> String {
    let mut out: String = qualified
        .replace("::", "__")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if out.len() > 64 {
        out.truncate(64); // all-ASCII, so byte index == char index
    }
    if out.is_empty() {
        out.push('t');
    }
    out
}

/// `sanitise` + collision avoidance against the names already declared this turn.
fn unique_sanitised(qualified: &str, seen: &mut HashSet<String>) -> String {
    let base = sanitise(qualified);
    if seen.insert(base.clone()) {
        return base;
    }
    let stem = &base[..base.len().min(60)];
    for i in 1.. {
        let cand = format!("{stem}_{i}");
        if seen.insert(cand.clone()) {
            return cand;
        }
    }
    unreachable!()
}

/// Ensure a JSON-Schema object is shaped the way the APIs expect (`type:object`
/// with a `properties` map), passing through everything the MCP tool already set.
fn normalize_schema(schema: Value) -> Value {
    match schema {
        Value::Object(mut m) => {
            m.entry("type").or_insert_with(|| json!("object"));
            m.entry("properties").or_insert_with(|| json!({}));
            Value::Object(m)
        }
        _ => json!({ "type": "object", "properties": {} }),
    }
}

/// Build the Anthropic user-message `content` for this turn. Plain string when no
/// images are attached; otherwise a content array of a text block + image blocks.
fn anthropic_user_content(prompt: &str, images: &[ImageInput]) -> Value {
    if images.is_empty() {
        return json!(prompt);
    }
    let mut blocks = vec![json!({ "type": "text", "text": prompt })];
    for (media_type, data) in images {
        blocks.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media_type, "data": data },
        }));
    }
    json!(blocks)
}

/// Build the OpenAI-compatible user-message `content` (text + `image_url` parts).
fn openai_user_content(prompt: &str, images: &[ImageInput]) -> Value {
    if images.is_empty() {
        return json!(prompt);
    }
    let mut parts = vec![json!({ "type": "text", "text": prompt })];
    for (media_type, data) in images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": data_uri(media_type, data) },
        }));
    }
    json!(parts)
}

/// Re-present tool-produced images to an OpenAI-compatible model as a user
/// message (the `tool` role can't carry image parts). Mirrors how the Anthropic
/// path puts image blocks inside the `tool_result`.
fn openai_image_followup(images: &[ImageInput]) -> Value {
    let mut parts = vec![json!({
        "type": "text",
        "text": "Here are the image(s) the tool(s) above produced, for you to look at:",
    })];
    for (media_type, data) in images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": data_uri(media_type, data) },
        }));
    }
    json!(parts)
}

/// A `data:` URI from an MCP image block's `(mimeType, base64 data)`.
fn data_uri(media_type: &str, data: &str) -> String {
    format!("data:{media_type};base64,{data}")
}

/// Pull `(mimeType, base64 data)` from every image block in an MCP tool result.
fn collect_tool_images(result: &Value) -> Vec<(String, String)> {
    let Some(arr) = result.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for b in arr {
        if b.get("type").and_then(Value::as_str) == Some("image") {
            let data = b.get("data").and_then(Value::as_str).unwrap_or("");
            let mime = b
                .get("mimeType")
                .or_else(|| b.get("mime_type"))
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            if !data.is_empty() {
                out.push((mime.to_string(), data.to_string()));
            }
        }
    }
    out
}

/// Build an Anthropic `tool_result` content value that includes any image blocks
/// (so the model can see them), plus the `data:` URIs for the UI. Falls back to a
/// plain text string when the tool returned no images.
fn anthropic_tool_result_content(result: &Value) -> (Value, Vec<String>) {
    let images = collect_tool_images(result);
    if images.is_empty() {
        return (json!(flatten_tool_result(result)), Vec::new());
    }
    let text = flatten_tool_result(result);
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    let mut uris = Vec::with_capacity(images.len());
    for (media_type, data) in images {
        blocks.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media_type, "data": data },
        }));
        uris.push(data_uri(&media_type, &data));
    }
    (json!(blocks), uris)
}

/// Flatten an MCP `CallToolResult` into a text string for a tool result block.
fn flatten_tool_result(result: &Value) -> String {
    let Some(arr) = result.get("content").and_then(Value::as_array) else {
        return result.to_string();
    };
    let mut parts = Vec::new();
    for b in arr {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    parts.push(t.to_string());
                }
            }
            Some("image") => parts.push("[image]".to_string()),
            Some("resource") => parts.push(format!(
                "[resource {}]",
                b.get("resource").and_then(|r| r.get("uri")).and_then(Value::as_str).unwrap_or("")
            )),
            _ => parts.push(b.to_string()),
        }
    }
    let joined = parts.join("\n");
    if joined.is_empty() {
        "(tool returned no textual content)".to_string()
    } else {
        joined
    }
}

/// Pull a human error message out of a provider's JSON body (`error.message`),
/// falling back to a truncated raw body. Both Anthropic and OpenAI use this shape.
fn api_error_message(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| raw.chars().take(300).collect())
}

/// Compact, secret-free description of a reqwest failure.
fn net_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "connection failed".into()
    } else if e.is_timeout() {
        "timed out".into()
    } else if let Some(s) = e.status() {
        format!("HTTP {}", s.as_u16())
    } else {
        "request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ToolCatalog {
        let mut resolver = HashMap::new();
        resolver.insert("srv__echo".to_string(), ("srv".to_string(), "echo".to_string()));
        ToolCatalog {
            resolver,
            items: vec![(
                "srv__echo".to_string(),
                "Echo back a message".to_string(),
                json!({ "type": "object", "properties": { "message": { "type": "string" } } }),
            )],
        }
    }

    #[test]
    fn sanitises_qualified_names() {
        assert_eq!(sanitise("w37oewqm6dc::echo"), "w37oewqm6dc__echo");
        assert_eq!(sanitise("srv::get-annotated.msg!"), "srv__get-annotated_msg_");
        assert!(sanitise(&"x".repeat(200)).len() == 64);
        assert_eq!(sanitise(""), "t");
    }

    #[test]
    fn unique_sanitised_avoids_collisions() {
        let mut seen = HashSet::new();
        assert_eq!(unique_sanitised("a::b", &mut seen), "a__b");
        assert_eq!(unique_sanitised("a::b", &mut seen), "a__b_1");
        assert_eq!(unique_sanitised("a::b", &mut seen), "a__b_2");
    }

    #[test]
    fn normalize_schema_fills_defaults() {
        let s = normalize_schema(json!({ "properties": { "x": { "type": "string" } } }));
        assert_eq!(s["type"], "object");
        assert!(s["properties"]["x"]["type"] == "string");
        assert_eq!(normalize_schema(json!("nope"))["type"], "object");
    }

    #[test]
    fn flattens_tool_result_text() {
        let r = json!({ "content": [ { "type": "text", "text": "hello" }, { "type": "image" } ], "isError": false });
        assert_eq!(flatten_tool_result(&r), "hello\n[image]");
        let empty = json!({ "content": [] });
        assert_eq!(flatten_tool_result(&empty), "(tool returned no textual content)");
    }

    #[test]
    fn extracts_assistant_text() {
        let msg = json!({
            "content": [
                { "type": "text", "text": "The answer is " },
                { "type": "tool_use", "id": "t1", "name": "x", "input": {} },
                { "type": "text", "text": "42." }
            ],
            "stop_reason": "end_turn"
        });
        assert_eq!(extract_anthropic_text(&msg), "The answer is 42.");
    }

    #[test]
    fn pick_falls_back_to_default() {
        assert_eq!(pick("", "deepseek-v4-flash"), "deepseek-v4-flash");
        assert_eq!(pick("  ", "x"), "x");
        assert_eq!(pick("kimi-k2.6", "x"), "kimi-k2.6");
    }

    #[test]
    fn anthropic_and_openai_decls_share_the_resolver() {
        let cat = catalog();
        let a = cat.anthropic_decls();
        let o = cat.openai_decls();
        // Anthropic shape: top-level name + input_schema.
        assert_eq!(a[0]["name"], "srv__echo");
        assert_eq!(a[0]["input_schema"]["type"], "object");
        // OpenAI shape: wrapped under function{} with parameters.
        assert_eq!(o[0]["type"], "function");
        assert_eq!(o[0]["function"]["name"], "srv__echo");
        assert_eq!(o[0]["function"]["parameters"]["properties"]["message"]["type"], "string");
        // Both resolve back to the same underlying MCP tool.
        assert_eq!(cat.resolver.get("srv__echo"), Some(&("srv".to_string(), "echo".to_string())));
    }

    #[test]
    fn collects_tool_images_and_builds_data_uri() {
        let r = json!({ "content": [
            { "type": "text", "text": "ok" },
            { "type": "image", "data": "QUJD", "mimeType": "image/png" }
        ]});
        let imgs = collect_tool_images(&r);
        assert_eq!(imgs, vec![("image/png".to_string(), "QUJD".to_string())]);
        assert_eq!(data_uri("image/png", "QUJD"), "data:image/png;base64,QUJD");
    }

    #[test]
    fn user_content_is_string_without_images_array_with() {
        // No images → plain string content.
        assert_eq!(anthropic_user_content("hi", &[]), json!("hi"));
        assert_eq!(openai_user_content("hi", &[]), json!("hi"));
        // With images → content array (text block + image block).
        let imgs = vec![("image/png".to_string(), "QUJD".to_string())];
        let a = anthropic_user_content("look", &imgs);
        assert_eq!(a[0]["type"], "text");
        assert_eq!(a[1]["type"], "image");
        assert_eq!(a[1]["source"]["data"], "QUJD");
        let o = openai_user_content("look", &imgs);
        assert_eq!(o[1]["type"], "image_url");
        assert_eq!(o[1]["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn openai_image_followup_wraps_images_in_a_user_turn() {
        let imgs = vec![("image/png".to_string(), "QUJD".to_string())];
        let v = openai_image_followup(&imgs);
        // text lead-in + one image_url part.
        assert_eq!(v[0]["type"], "text");
        assert_eq!(v[1]["type"], "image_url");
        assert_eq!(v[1]["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn anthropic_tool_result_includes_images_when_present() {
        let r = json!({ "content": [ { "type": "image", "data": "QUJD", "mimeType": "image/jpeg" } ]});
        let (content, uris) = anthropic_tool_result_content(&r);
        assert!(content.is_array());
        assert_eq!(uris, vec!["data:image/jpeg;base64,QUJD".to_string()]);
        // No image → plain string content, no uris.
        let (c2, u2) = anthropic_tool_result_content(&json!({ "content": [ { "type": "text", "text": "x" } ]}));
        assert!(c2.is_string());
        assert!(u2.is_empty());
    }

    #[test]
    fn clean_title_strips_quotes_markdown_and_punctuation() {
        assert_eq!(clean_title("\"Quarterly Sales Review\""), "Quarterly Sales Review");
        assert_eq!(clean_title("**Trip Planning**."), "Trip Planning");
        assert_eq!(clean_title("Budget Forecast\nsecond line"), "Budget Forecast");
        assert!(clean_title(&"word ".repeat(40)).chars().count() <= 60);
    }

    #[test]
    fn api_error_message_extracts_or_truncates() {
        assert_eq!(api_error_message(r#"{"error":{"message":"bad key"}}"#), "bad key");
        let raw = "not json at all";
        assert_eq!(api_error_message(raw), raw);
    }
}
