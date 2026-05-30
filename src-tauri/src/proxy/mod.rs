//! Local LiteLLM BYOK proxy supervisor (§6).
//!
//! Supervises a LiteLLM proxy child (shipped as a Tauri **sidecar**, resolved by
//! `bundle.externalBin` in `tauri.conf.json`) bound to `127.0.0.1:4000`, turning
//! it into an OpenAI-compatible switchboard for external tools (e.g. Claude Code
//! → base URL `http://127.0.0.1:4000`).
//!
//! Security (§5/§6): the provider key is **unsealed in the backend** by the Phase
//! 5 crypto layer and injected into the child's **environment** at spawn time. The
//! generated `litellm_config.yaml` references it as `os.environ/...`, so the
//! plaintext key is never written to disk and never crosses IPC to the webview.
//!
//! NOTE (dev): `binaries/litellm-proxy-<triple>` is currently a **mock** that just
//! prints the bind line and idles — enough to exercise spawn → bind-detection →
//! kill. Swapping in the real PyInstaller bundle leaves this supervisor unchanged.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Sidecar base name (matches `bundle.externalBin` minus the target-triple suffix
/// the bundler strips when copying the binary next to the app executable).
const SIDECAR: &str = "litellm-proxy";
/// Env var the generated config reads via `os.environ/...`, so the plaintext key
/// is injected at spawn time and never persisted to the yaml.
const KEY_ENV: &str = "TRENLENS_PROVIDER_KEY";
/// Default OpenAI-compatible port LiteLLM binds.
pub const DEFAULT_PORT: u16 = 4000;

/// Snapshot of the proxy lifecycle, surfaced verbatim to the frontend toggle.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub provider: Option<String>,
    pub message: Option<String>,
}

impl Default for ProxyStatus {
    fn default() -> Self {
        Self {
            running: false,
            port: None,
            url: None,
            provider: None,
            message: None,
        }
    }
}

/// Start parameters. `api_key` is the **already-unsealed** plaintext (or `None`
/// to run keyless); it lives only in backend memory and is handed straight to the
/// child via env — never logged, never written to the config file.
pub struct StartParams {
    pub provider: String,
    pub model: Option<String>,
    pub port: u16,
    pub api_key: Option<String>,
}

/// Tauri-managed supervisor: the live child handle + a shared status snapshot the
/// stdout monitor task and the IPC commands both read/write.
#[derive(Default)]
pub struct ProxyState {
    status: Arc<Mutex<ProxyStatus>>,
    child: Arc<Mutex<Option<CommandChild>>>,
}

impl ProxyState {
    pub fn status(&self) -> ProxyStatus {
        self.status.lock().unwrap().clone()
    }

    /// Spawn the sidecar, write its config, and monitor stdout for the bind line.
    /// Returns the provisional status immediately (the monitor task refines it to
    /// `running + port` once the child reports it is listening).
    pub fn start<R: Runtime>(&self, app: &AppHandle<R>, params: StartParams) -> Result<ProxyStatus, String> {
        if self.status.lock().unwrap().running {
            return Err("BYOK proxy is already running".into());
        }

        // 1) Materialise the config (secrets via env, not on disk).
        let cfg_path = write_config(app, &params)?;

        // 2) Build + spawn the sidecar with the config path as an argument.
        let mut cmd = app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|e| format!("resolving sidecar '{SIDECAR}': {e}"))?
            .args(["--config", &cfg_path.to_string_lossy()]);
        if let Some(key) = &params.api_key {
            cmd = cmd.env(KEY_ENV, key); // injected here only — never on disk
        }
        let (mut rx, child) = cmd.spawn().map_err(|e| format!("spawning sidecar: {e}"))?;
        let pid = child.pid();

        // 3) Record provisional status + stash the child handle for stop().
        {
            let mut st = self.status.lock().unwrap();
            st.running = true;
            st.port = None;
            st.url = None;
            st.provider = Some(params.provider.clone());
            st.message = Some(format!("starting (pid {pid})…"));
        }
        *self.child.lock().unwrap() = Some(child);

        // 4) Monitor the event stream: detect the bind line, reflect termination.
        let status = self.status.clone();
        let child_slot = self.child.clone();
        let fallback_port = params.port;
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes);
                        let lower = line.to_lowercase();
                        if lower.contains("running") && lower.contains("127.0.0.1:") {
                            let port = parse_port(&line).unwrap_or(fallback_port);
                            let mut st = status.lock().unwrap();
                            st.running = true;
                            st.port = Some(port);
                            st.url = Some(format!("http://127.0.0.1:{port}"));
                            st.message = Some("listening".into());
                        }
                        eprintln!("[proxy] {}", line.trim_end());
                    }
                    CommandEvent::Terminated(payload) => {
                        let mut st = status.lock().unwrap();
                        st.running = false;
                        st.port = None;
                        st.url = None;
                        st.message = Some(format!("exited (code {:?})", payload.code));
                        *child_slot.lock().unwrap() = None;
                        break;
                    }
                    CommandEvent::Error(e) => {
                        status.lock().unwrap().message = Some(format!("error: {e}"));
                    }
                    _ => {}
                }
            }
        });

        Ok(self.status())
    }

    /// Kill the child (if any) and mark the proxy stopped.
    pub fn stop(&self) -> Result<ProxyStatus, String> {
        if let Some(child) = self.child.lock().unwrap().take() {
            child.kill().map_err(|e| format!("killing sidecar: {e}"))?;
        }
        let mut st = self.status.lock().unwrap();
        st.running = false;
        st.port = None;
        st.url = None;
        st.message = Some("stopped".into());
        Ok(st.clone())
    }
}

/// Write a minimal LiteLLM proxy config to the app data dir, returning its path.
/// The secret is referenced as `os.environ/<KEY_ENV>` — resolved by LiteLLM from
/// the environment we set on the child — so no plaintext lands in the file.
fn write_config<R: Runtime>(app: &AppHandle<R>, params: &StartParams) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app dir: {e}"))?;
    let path = dir.join("litellm_config.yaml");

    let model = params
        .model
        .clone()
        .unwrap_or_else(|| default_model(&params.provider));
    let key_line = if params.api_key.is_some() {
        format!("      api_key: os.environ/{KEY_ENV}\n")
    } else {
        String::new()
    };

    let yaml = format!(
        "# Generated by trenlens-core — regenerated on each proxy start. DO NOT EDIT.\n\
# Provider secrets are injected via the environment (os.environ/...), so the\n\
# plaintext key is NEVER written to this file (§5/§6).\n\
model_list:\n\
  - model_name: default\n\
    litellm_params:\n\
      model: {model}\n\
{key_line}general_settings:\n\
  port: {port}\n\
litellm_settings:\n\
  drop_params: true\n",
        model = model,
        key_line = key_line,
        port = params.port,
    );

    std::fs::write(&path, yaml).map_err(|e| format!("writing config: {e}"))?;
    Ok(path)
}

/// A sensible default LiteLLM model string per known provider.
fn default_model(provider: &str) -> String {
    match provider {
        "anthropic" => "anthropic/claude-3-5-sonnet-latest",
        "openai" => "openai/gpt-4o",
        "openrouter" => "openrouter/auto",
        other => return format!("{other}/default"),
    }
    .to_string()
}

/// Pull the port out of a `…127.0.0.1:<port>…` log line.
fn parse_port(line: &str) -> Option<u16> {
    let marker = "127.0.0.1:";
    let start = line.find(marker)? + marker.len();
    line[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bind_port() {
        assert_eq!(parse_port("INFO: Proxy running on http://127.0.0.1:4000"), Some(4000));
        assert_eq!(parse_port("Uvicorn running on http://127.0.0.1:8080 (Press ..)"), Some(8080));
        assert_eq!(parse_port("no port here"), None);
    }

    #[test]
    fn default_model_per_provider() {
        assert_eq!(default_model("anthropic"), "anthropic/claude-3-5-sonnet-latest");
        assert_eq!(default_model("mistral"), "mistral/default");
    }
}
