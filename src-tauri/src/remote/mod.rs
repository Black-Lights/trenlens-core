//! Remote Control subsystem (Phase 3+).
//!
//! Phase 3 lands the security layer: the ephemeral E2E key + pairing id (`session`)
//! and the `remote_start_pairing` IPC the desktop UI calls to render the QR. The
//! headless WebSocket client that joins the relay and pipes decrypted commands into
//! `orchestrator::run_chat` arrives in Phase 4 (`client`/`protocol`).

#![allow(dead_code)]

mod session;

pub use session::{decrypt, encrypt, PairingSession, RemoteEnvelope};

use std::sync::Mutex;

use serde::Serialize;

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

/// Tauri-managed Remote Control state. For Phase 3 it holds the current armed
/// pairing session (the ephemeral key + room id); Phase 4 adds the connection
/// handle, JWT, and status. Mirrors the managed-state pattern of `ProxyState` /
/// `HostState` wired in `lib.rs`.
#[derive(Default)]
pub struct RemoteState {
    session: Mutex<Option<PairingSession>>,
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

    /// Encrypt with the armed session's key (Phase 4 outbound frames). `None` when
    /// no pairing is active.
    pub fn encrypt(&self, plaintext: &[u8]) -> Option<Result<RemoteEnvelope, String>> {
        self.session
            .lock()
            .expect("remote session lock poisoned")
            .as_ref()
            .map(|s| s.encrypt(plaintext))
    }

    /// Decrypt an inbound envelope with the armed session's key (Phase 4). `None`
    /// when no pairing is active.
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
