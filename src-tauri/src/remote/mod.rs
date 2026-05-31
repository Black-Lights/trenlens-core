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

use protocol::{new_msg_id, seal, HistoryTurn, RemoteMessage};

/// Tauri event emitted on every connection-state transition (no secrets in payload).
/// The frontend panel subscribes to this for live status; `remote_status` polls it.
pub const STATUS_EVENT: &str = "remote://status";

/// Tauri event carrying a phone-initiated turn so it renders LIVE in the desktop
/// timeline (Phase 6 two-way sync). Emitted twice per remote turn — `role:"user"`
/// when the prompt arrives, `role:"assistant"` when the answer is ready (same `id`
/// so the UI correlates them). Carries only chat text, never a secret.
pub const TURN_EVENT: &str = "remote://turn";

/// Payload of `TURN_EVENT`: one side of a phone-driven turn, scoped to the desktop
/// conversation it belongs to (so the UI only appends it to the matching chat).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTurn {
    pub conversation_id: String,
    pub id: String,
    pub role: String,
    pub text: String,
    pub tools_used: Vec<String>,
    pub images: Vec<String>,
}

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
    /// Outbound-frame sender into the socket's single writer. Held here (not just
    /// inside the task) so the desktop side can push frames to the phone — a mirrored
    /// `peerTurn` or a `history` backfill — without owning the socket.
    out_tx: mpsc::Sender<String>,
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
    /// The desktop's active conversation, mirrored to the phone (the shared session).
    /// Set by `remote_set_conversation` as the user switches chats; a desktop turn in
    /// this conversation is broadcast to the phone, and `historyRequest` replies from
    /// it. `None` until the desktop binds a conversation.
    bound_session: Mutex<Option<String>>,
    /// The desktop's selected provider/model, so a phone turn (which sends neither)
    /// runs on the SAME engine the desktop user picked — not just the anthropic
    /// default — making remote work for every supported provider (deepseek/kimi/…).
    bound_provider: Mutex<Option<String>>,
    bound_model: Mutex<Option<String>>,
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
        // The outbound-frame channel lives HERE (not inside the task) so it survives
        // reconnects and so `out_tx` can be handed to both the writer task and the
        // desktop-side senders (`broadcast_turn` / `push_history`). 64 is plenty for
        // the low frame rate; a wedged socket back-pressures and we drop on error.
        let (out_tx, out_rx) = mpsc::channel::<String>(64);

        let join = tauri::async_runtime::spawn(client::run(
            app.clone(),
            session,
            relay_url,
            jwt,
            control_rx,
            status_tx,
            out_tx.clone(),
            out_rx,
        ));

        *self.conn.lock().expect("remote conn lock poisoned") = Some(ConnHandle {
            control_tx,
            join,
            status_rx,
            out_tx,
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
        self.set_bound_session(None);
        self.set_bound_model(None, None);
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

    // ── Live two-way sync (Phase 6) ──────────────────────────────────────────

    /// Bind (or clear) the shared conversation the phone mirrors. A desktop turn in
    /// this session is broadcast to the phone, and `historyRequest` replies from it.
    pub fn set_bound_session(&self, session_id: Option<String>) {
        *self.bound_session.lock().expect("remote bound lock poisoned") = session_id;
    }

    /// The shared conversation id (the desktop's active chat), if one is bound.
    pub fn bound_session(&self) -> Option<String> {
        self.bound_session.lock().expect("remote bound lock poisoned").clone()
    }

    /// Record the desktop's active provider/model so a phone turn adopts them.
    pub fn set_bound_model(&self, provider: Option<String>, model: Option<String>) {
        *self.bound_provider.lock().expect("remote bound lock poisoned") = provider;
        *self.bound_model.lock().expect("remote bound lock poisoned") = model;
    }

    /// The desktop's selected provider, if any (for phone turns that send none).
    pub fn bound_provider(&self) -> Option<String> {
        self.bound_provider.lock().expect("remote bound lock poisoned").clone()
    }

    /// The desktop's selected model, if any (used with `bound_provider`).
    pub fn bound_model(&self) -> Option<String> {
        self.bound_model.lock().expect("remote bound lock poisoned").clone()
    }

    /// Push the shared session's stored timeline to the phone so it backfills and
    /// adopts the desktop's conversation id. Best-effort (no-op if not connected).
    pub fn push_history(&self, session_id: &str, turns: Vec<(String, String)>) {
        let messages = turns.into_iter().map(|(role, content)| HistoryTurn { role, content }).collect();
        self.send_message(&RemoteMessage::history(new_msg_id(), session_id.to_string(), messages));
    }

    /// Mirror a DESKTOP-typed turn (prompt + answer) to the phone — but only when it
    /// belongs to the bound shared session, so unrelated local chats don't leak to a
    /// paired phone. No-op when nothing is connected.
    pub fn broadcast_turn(
        &self,
        session_id: Option<&str>,
        user_text: &str,
        text: &str,
        tools_used: &[String],
        images: &[String],
    ) {
        let Some(sid) = session_id else { return };
        if self.bound_session().as_deref() != Some(sid) {
            return;
        }
        self.send_message(&RemoteMessage::peer_turn(
            new_msg_id(),
            user_text.to_string(),
            text.to_string(),
            tools_used.to_vec(),
            images.to_vec(),
        ));
    }

    /// Seal a message with the armed key and queue it on the live connection's
    /// outbound channel. Fail-quiet: a no-op when nothing is armed or connected, and
    /// it never blocks (a full/closed channel just drops the frame).
    fn send_message(&self, msg: &RemoteMessage) {
        let out_tx = match &*self.conn.lock().expect("remote conn lock poisoned") {
            Some(h) => h.out_tx.clone(),
            None => return,
        };
        let session = match self.session.lock().expect("remote session lock poisoned").as_ref() {
            Some(s) => s.clone(),
            None => return,
        };
        if let Ok(frame) = seal(&session, msg) {
            let _ = out_tx.try_send(frame);
        }
    }
}
