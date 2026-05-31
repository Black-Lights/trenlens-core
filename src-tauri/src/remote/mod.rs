//! Remote Control subsystem.
//!
//! Phase 3 landed the security layer: the ephemeral E2E key + pairing id (`session`)
//! and the `remote_start_pairing` IPC the desktop UI calls to render the QR.
//!
//! Phase 4 adds the headless WebSocket client (`client`) that joins the Cloudflare
//! blind relay and pipes decrypted commands into `orchestrator::run_turn`, plus the
//! `protocol` wire types that live inside the encrypted envelope. `RemoteState` now
//! also owns the live connection (a background task handle + control channel +
//! status), mirroring the managed-state pattern of `ProxyState` / `HostState`.

#![allow(dead_code)]

mod client;
mod protocol;
mod session;

pub use session::{PairingSession, RemoteEnvelope};

use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::{mpsc, watch};

/// Tauri event emitted on every connection-state transition (no secrets in payload).
/// The frontend panel subscribes to this for live status; `remote_status` polls it.
pub const STATUS_EVENT: &str = "remote://status";

/// The QR payload returned to the desktop UI by `remote_start_pairing`. `keyB64Url`
/// is the only form of the key that ever leaves Rust, and only so the webview can
/// draw it into the QR — the mobile receives the key by scanning, never via IPC.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub pairing_id: String,
    pub key_b64url: String,
    pub uri: String,
}

/// Connection state reported to the frontend. `paired` is true whenever a session is
/// armed (a QR is live); `room_id` is the non-secret pairing id (the key is the
/// secret and is never included).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// `offline` | `connecting` | `connected` | `reconnecting`.
    pub state: String,
    pub paired: bool,
    pub room_id: Option<String>,
}

impl RemoteStatus {
    fn at(state: &str, room_id: Option<&str>) -> Self {
        RemoteStatus {
            state: state.to_string(),
            paired: room_id.is_some(),
            room_id: room_id.map(str::to_string),
        }
    }
    pub fn offline() -> Self {
        Self::at("offline", None)
    }
    pub fn connecting(room: &str) -> Self {
        Self::at("connecting", Some(room))
    }
    pub fn connected(room: &str) -> Self {
        Self::at("connected", Some(room))
    }
    pub fn reconnecting(room: &str) -> Self {
        Self::at("reconnecting", Some(room))
    }
}

/// Messages the IPC commands send into the running socket task.
pub enum ControlMsg {
    /// A refreshed Supabase token, applied on the next reconnect (§3.1).
    Token(String),
    /// Stop the client (graceful close, then the task ends).
    Shutdown,
}

/// Handle to the live background connection held in `RemoteState`.
struct ConnHandle {
    control_tx: mpsc::Sender<ControlMsg>,
    join: tauri::async_runtime::JoinHandle<()>,
    status_rx: watch::Receiver<RemoteStatus>,
}

/// Where the desktop dials the relay. Defaults to the local `wrangler dev` address
/// so Phase-4 testing works out of the box; override per-connect or via
/// `TRENLENS_RELAY_URL` (prod points at the deployed Worker, `wss://…/connect`).
pub fn default_relay_url() -> String {
    std::env::var("TRENLENS_RELAY_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "ws://127.0.0.1:8787/connect".to_string())
}

/// Tauri-managed Remote Control state: the armed pairing session (ephemeral key +
/// room id) and the live connection (if any). Mirrors `ProxyState`/`HostState`.
#[derive(Default)]
pub struct RemoteState {
    session: Mutex<Option<PairingSession>>,
    conn: Mutex<Option<ConnHandle>>,
}

impl RemoteState {
    /// Arm a fresh pairing: mint a new key + pairing id (rotating any previous key,
    /// so re-pairing invalidates an old QR) and return the QR payload.
    pub fn start_pairing(&self) -> PairingInfo {
        let s = PairingSession::new();
        let info = PairingInfo {
            pairing_id: s.pairing_id.clone(),
            key_b64url: s.key_b64url(),
            uri: s.pair_uri(),
        };
        *self.session.lock().expect("remote session lock poisoned") = Some(s);
        info
    }

    /// Open the relay connection for the armed session and spawn the background
    /// client. Errors if no pairing is armed (the user must generate a QR first).
    /// Re-connecting replaces any prior connection.
    pub fn connect(&self, app: &AppHandle, jwt: String, relay_url: Option<String>) -> Result<RemoteStatus, String> {
        let session = self
            .session
            .lock()
            .expect("remote session lock poisoned")
            .as_ref()
            .cloned()
            .ok_or_else(|| "no pairing armed — generate a QR (Start pairing) first".to_string())?;
        let room_id = session.pairing_id.clone();
        let relay_url = relay_url
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(default_relay_url);

        // Replace any prior connection so re-connect is idempotent.
        self.stop_connection();

        let (control_tx, control_rx) = mpsc::channel::<ControlMsg>(8);
        let initial = RemoteStatus::connecting(&room_id);
        let (status_tx, status_rx) = watch::channel(initial.clone());

        let join = tauri::async_runtime::spawn(client::run(
            app.clone(),
            session,
            relay_url,
            jwt,
            control_rx,
            status_tx,
        ));

        *self.conn.lock().expect("remote conn lock poisoned") = Some(ConnHandle {
            control_tx,
            join,
            status_rx,
        });
        Ok(initial)
    }

    /// Push a refreshed Supabase token into the running task (used on next reconnect).
    pub fn update_token(&self, jwt: String) -> Result<(), String> {
        match &*self.conn.lock().expect("remote conn lock poisoned") {
            Some(h) => h
                .control_tx
                .try_send(ControlMsg::Token(jwt))
                .map_err(|e| format!("token channel: {e}")),
            None => Err("remote control is not connected".into()),
        }
    }

    /// Stop the client AND drop the E2E key: a manual disconnect revokes pairing, so
    /// reconnecting requires a fresh QR scan (max-security default, decision #2).
    pub fn disconnect(&self) -> RemoteStatus {
        self.stop_connection();
        self.clear();
        RemoteStatus::offline()
    }

    /// Current connection state (the task's latest published status, or `offline`).
    pub fn status(&self) -> RemoteStatus {
        match &*self.conn.lock().expect("remote conn lock poisoned") {
            Some(h) => h.status_rx.borrow().clone(),
            None => RemoteStatus::offline(),
        }
    }

    /// Tear down the live connection if present: ask the task to stop gracefully,
    /// then abort to guarantee it's gone even if it was wedged mid-connect.
    fn stop_connection(&self) {
        if let Some(handle) = self.conn.lock().expect("remote conn lock poisoned").take() {
            let _ = handle.control_tx.try_send(ControlMsg::Shutdown);
            handle.join.abort();
        }
    }

    /// Encrypt with the armed session's key. `None` when no pairing is active.
    pub fn encrypt(&self, plaintext: &[u8]) -> Option<Result<RemoteEnvelope, String>> {
        self.session
            .lock()
            .expect("remote session lock poisoned")
            .as_ref()
            .map(|s| s.encrypt(plaintext))
    }

    /// Decrypt an inbound envelope with the armed session's key. `None` when no
    /// pairing is active.
    pub fn decrypt(&self, env: &RemoteEnvelope) -> Option<Result<Vec<u8>, String>> {
        self.session
            .lock()
            .expect("remote session lock poisoned")
            .as_ref()
            .map(|s| s.decrypt(env))
    }

    /// Drop the armed session (stop sharing / revoke the key).
    pub fn clear(&self) {
        *self.session.lock().expect("remote session lock poisoned") = None;
    }
}
