//! Remote Control wire protocol (Phase 4) — the `RemoteMessage` payloads that live
//! INSIDE the encrypted `{iv, ct}` envelope, plus the seal/open helpers.
//!
//! The relay only ever sees the opaque envelope (`session::RemoteEnvelope`); the
//! whole application message — including its `type` — is the ciphertext, so the
//! relay learns nothing but frame size/timing. These types mirror the frozen
//! contract in REMOTE_ARCHITECTURE_PLAN.md §3.2: an internally-tagged enum keyed by
//! `"type"`, with camelCase fields on the wire (sessionId, toolsUsed, mediaType).
//!
//! Direction is a convention, not enforced here:
//!   phone → desktop: `chat`, `historyRequest`
//!   desktop → phone: `chatResult`, `error`, `history`, `presence`, `peerTurn`
//!
//! Live two-way sync (Phase 6): `history` carries the desktop's active `sessionId`
//! so the phone adopts the same conversation; `peerTurn` mirrors a turn the DESKTOP
//! user typed (their prompt + the answer) onto the phone, so both timelines match.

#![allow(dead_code)]

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::OsRng;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::session::{PairingSession, RemoteEnvelope};

/// A user-attached image inside a `chat` message: `(mediaType, base64 data)` with
/// no `data:` prefix — the same shape the orchestrator's `ImageInput` expects.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImage {
    pub media_type: String,
    pub data: String,
}

/// One prior turn in a `history` response.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HistoryTurn {
    pub role: String,
    pub content: String,
}

/// The decrypted application message. Internally tagged by `type`; the enum-level
/// `rename_all` maps variant names to the wire tags (`Chat` → `"chat"`,
/// `ChatResult` → `"chatResult"`), and each variant renames its own fields to
/// camelCase. Optional `chat` fields default so a minimal `{type,id,text}` parses.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteMessage {
    /// phone → desktop: run this prompt through the orchestrator.
    #[serde(rename_all = "camelCase")]
    Chat {
        id: String,
        text: String,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        images: Vec<RemoteImage>,
    },
    /// desktop → phone: the assistant's answer (echoes the request `id`).
    #[serde(rename_all = "camelCase")]
    ChatResult {
        id: String,
        text: String,
        tools_used: Vec<String>,
        images: Vec<String>,
    },
    /// desktop → phone: the turn failed (echoes the request `id`).
    Error { id: String, code: String, message: String },
    /// either direction: liveness / who's-online signal.
    Presence { id: String, role: String, online: bool },
    /// phone → desktop: replay the shared session's stored timeline (the desktop
    /// answers from its OWN bound conversation, so the phone's `sessionId` here is
    /// only a hint — the reply carries the authoritative id to adopt).
    #[serde(rename_all = "camelCase")]
    HistoryRequest {
        id: String,
        session_id: String,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// desktop → phone: the stored timeline PLUS the active `sessionId` the phone
    /// should adopt, so its next `chat` lands in the same conversation.
    #[serde(rename_all = "camelCase")]
    History { id: String, session_id: String, messages: Vec<HistoryTurn> },
    /// desktop → phone: a turn the DESKTOP user typed locally, mirrored so the phone
    /// shows it too (their prompt as a user bubble + the assistant's answer).
    #[serde(rename_all = "camelCase")]
    PeerTurn {
        id: String,
        user_text: String,
        text: String,
        tools_used: Vec<String>,
        images: Vec<String>,
    },
}

impl RemoteMessage {
    /// A `chatResult` for an answered turn, carrying the request's `id` back.
    pub fn chat_result(id: impl Into<String>, text: String, tools_used: Vec<String>, images: Vec<String>) -> Self {
        RemoteMessage::ChatResult { id: id.into(), text, tools_used, images }
    }

    /// An `error` reply for a failed turn, carrying the request's `id` back.
    pub fn error(id: impl Into<String>, code: impl Into<String>, message: impl Into<String>) -> Self {
        RemoteMessage::Error { id: id.into(), code: code.into(), message: message.into() }
    }

    /// A desktop presence beacon (fresh id — not tied to any request).
    pub fn desktop_online() -> Self {
        RemoteMessage::Presence { id: new_msg_id(), role: "desktop".into(), online: true }
    }

    /// A `history` reply: the shared session's timeline + the id the phone adopts.
    pub fn history(id: impl Into<String>, session_id: impl Into<String>, messages: Vec<HistoryTurn>) -> Self {
        RemoteMessage::History { id: id.into(), session_id: session_id.into(), messages }
    }

    /// A `peerTurn`: a desktop-typed turn (prompt + answer) mirrored to the phone.
    pub fn peer_turn(
        id: impl Into<String>,
        user_text: String,
        text: String,
        tools_used: Vec<String>,
        images: Vec<String>,
    ) -> Self {
        RemoteMessage::PeerTurn { id: id.into(), user_text, text, tools_used, images }
    }
}

/// A short random message id for unsolicited frames (presence/beacons). Replies
/// (`chatResult`/`error`/`history`) echo the request id instead. 12 bytes →
/// 16 base64url chars — enough to correlate, and dependency-free (no ULID crate).
pub fn new_msg_id() -> String {
    let mut b = [0u8; 12];
    OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// Seal a `RemoteMessage` into a wire frame: JSON → AES-GCM `{iv, ct}` → JSON text.
/// This serialized envelope is exactly what the relay forwards verbatim.
pub fn seal(session: &PairingSession, msg: &RemoteMessage) -> Result<String, String> {
    let bytes = serde_json::to_vec(msg).map_err(|e| format!("serialize message: {e}"))?;
    let env = session.encrypt(&bytes)?;
    serde_json::to_string(&env).map_err(|e| format!("serialize envelope: {e}"))
}

/// Open a wire frame back into a `RemoteMessage`: JSON envelope → decrypt (the GCM
/// tag is verified; wrong key / tamper fails closed) → JSON message.
pub fn open(session: &PairingSession, frame: &str) -> Result<RemoteMessage, String> {
    let env: RemoteEnvelope = serde_json::from_str(frame).map_err(|e| format!("parse envelope: {e}"))?;
    let bytes = session.decrypt(&env)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse message: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_parses_minimal_and_full() {
        // Minimal: optional fields default (no provider/model/session/images).
        let m: RemoteMessage = serde_json::from_str(r#"{"type":"chat","id":"1","text":"hi"}"#).unwrap();
        match m {
            RemoteMessage::Chat { id, text, provider, model, session_id, images } => {
                assert_eq!((id.as_str(), text.as_str()), ("1", "hi"));
                assert!(provider.is_none() && model.is_none() && session_id.is_none());
                assert!(images.is_empty());
            }
            _ => panic!("expected Chat"),
        }
        // Full: camelCase sessionId + image mediaType land in the right fields.
        let full = json!({
            "type": "chat", "id": "2", "text": "look",
            "provider": "anthropic", "model": null, "sessionId": "s-1",
            "images": [{ "mediaType": "image/png", "data": "QUJD" }]
        });
        let m: RemoteMessage = serde_json::from_value(full).unwrap();
        match m {
            RemoteMessage::Chat { session_id, provider, images, .. } => {
                assert_eq!(session_id.as_deref(), Some("s-1"));
                assert_eq!(provider.as_deref(), Some("anthropic"));
                assert_eq!(images, vec![RemoteImage { media_type: "image/png".into(), data: "QUJD".into() }]);
            }
            _ => panic!("expected Chat"),
        }
    }

    #[test]
    fn chat_result_serializes_with_camelcase_tag_and_fields() {
        let m = RemoteMessage::chat_result("abc", "done".into(), vec!["list_events".into()], vec!["data:x".into()]);
        let v: serde_json::Value = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], "chatResult");
        assert_eq!(v["id"], "abc");
        assert_eq!(v["toolsUsed"][0], "list_events");
        assert_eq!(v["images"][0], "data:x");
    }

    #[test]
    fn error_and_presence_shapes() {
        let e: serde_json::Value = serde_json::to_value(RemoteMessage::error("id1", "no_key", "missing")).unwrap();
        assert_eq!(e["type"], "error");
        assert_eq!((e["code"].as_str(), e["message"].as_str()), (Some("no_key"), Some("missing")));
        let p: serde_json::Value = serde_json::to_value(RemoteMessage::desktop_online()).unwrap();
        assert_eq!(p["type"], "presence");
        assert_eq!((p["role"].as_str(), p["online"].as_bool()), (Some("desktop"), Some(true)));
        assert!(p["id"].as_str().is_some_and(|s| !s.is_empty()));
    }

    #[test]
    fn history_and_peer_turn_carry_camelcase_payloads() {
        let h = RemoteMessage::history(
            "r1",
            "rmt_abc",
            vec![HistoryTurn { role: "user".into(), content: "hi".into() }],
        );
        let v: serde_json::Value = serde_json::to_value(&h).unwrap();
        assert_eq!(v["type"], "history");
        assert_eq!(v["sessionId"], "rmt_abc");
        assert_eq!(v["messages"][0]["role"], "user");

        let pt = RemoteMessage::peer_turn("p1", "draft a note".into(), "Here you go.".into(), vec!["fs__write".into()], vec![]);
        let v: serde_json::Value = serde_json::to_value(&pt).unwrap();
        assert_eq!(v["type"], "peerTurn");
        assert_eq!(v["userText"], "draft a note");
        assert_eq!(v["text"], "Here you go.");
        assert_eq!(v["toolsUsed"][0], "fs__write");
    }

    #[test]
    fn seal_open_round_trips_through_the_session_codec() {
        let session = PairingSession::new();
        let msg = RemoteMessage::Chat {
            id: "9".into(), text: "what's on my calendar?".into(),
            provider: Some("anthropic".into()), model: None, session_id: Some("s".into()), images: vec![],
        };
        let frame = seal(&session, &msg).unwrap();
        // The frame is an opaque {iv, ct} envelope — no plaintext leaks.
        assert!(!frame.contains("calendar"));
        assert!(frame.contains("\"iv\"") && frame.contains("\"ct\""));
        assert_eq!(open(&session, &frame).unwrap(), msg);
    }

    #[test]
    fn open_fails_closed_for_a_foreign_key() {
        let a = PairingSession::new();
        let b = PairingSession::new();
        let frame = seal(&a, &RemoteMessage::desktop_online()).unwrap();
        assert!(open(&b, &frame).is_err());
    }
}
