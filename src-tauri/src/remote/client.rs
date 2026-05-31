//! Remote Control desktop client (Phase 4) — the headless background WebSocket task.
//!
//! Spawned on demand (`remote_connect`), it joins the Cloudflare blind relay as
//! `role.desktop`, then for every inbound `{iv, ct}` frame: decrypt → run through
//! the SAME `orchestrator::run_turn` a local turn uses → encrypt the answer back.
//! It runs entirely on `tauri::async_runtime` (never the UI thread) and survives
//! network drops with capped exponential backoff, re-presenting a fresh JWT on each
//! reconnect (the relay only checks the token at the upgrade, §3.1).
//!
//! Concurrency shape: the socket is split into a read half and a write half. A
//! bounded `mpsc<String>` funnels every outbound frame (chat results, the presence
//! beacon) through the single writer, so overlapping turns — each handled in its own
//! spawned task so a slow tool-loop never stalls reads — serialize cleanly without a
//! `Mutex<Sink>`. A `watch<RemoteStatus>` + a Tauri event publish connection state.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::crypto::CryptoState;
use crate::mcp::McpRouter;
use crate::memory::MemoryHandle;
use crate::orchestrator::{run_turn, TurnParams};

use super::protocol::{open, seal, RemoteImage, RemoteMessage};
use super::session::PairingSession;
use super::{ControlMsg, RemoteStatus, STATUS_EVENT};

/// The version tag offered first in `Sec-WebSocket-Protocol`; the relay echoes it.
const RELAY_SUBPROTOCOL: &str = "trenlens.relay.v1";
/// Reconnect backoff bounds.
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Cap a single connect attempt so a black-holed network can't wedge the task.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Why the inner (connected) loop ended.
enum LoopEnd {
    /// The user asked to stop (`remote_disconnect` / control `Shutdown`).
    Shutdown,
    /// The socket dropped/closed/errored — the outer loop should reconnect.
    Disconnected,
}

/// The background task. Owns a snapshot of the armed session (so it can seal/open
/// frames off-thread), the current JWT (refreshable via the control channel), and
/// the relay URL. Returns only on `Shutdown`; otherwise reconnects forever.
pub async fn run(
    app: AppHandle,
    session: PairingSession,
    relay_url: String,
    mut jwt: String,
    mut control_rx: mpsc::Receiver<ControlMsg>,
    status_tx: watch::Sender<RemoteStatus>,
) {
    let room_id = session.pairing_id.clone();
    let mut backoff = INITIAL_BACKOFF;

    loop {
        publish(&app, &status_tx, RemoteStatus::connecting(&room_id));
        match connect(&relay_url, &jwt, &room_id).await {
            Ok(ws) => {
                backoff = INITIAL_BACKOFF; // a successful handshake resets backoff
                publish(&app, &status_tx, RemoteStatus::connected(&room_id));
                match serve(&app, &session, ws, &mut jwt, &mut control_rx).await {
                    LoopEnd::Shutdown => {
                        publish(&app, &status_tx, RemoteStatus::offline());
                        return;
                    }
                    LoopEnd::Disconnected => {}
                }
            }
            // `connect` errors are already redacted (never carry the token).
            Err(e) => eprintln!("[remote] connect failed: {e}"),
        }

        // Disconnected (or failed to connect): back off, but stay responsive to a
        // Shutdown or a refreshed token while we wait.
        publish(&app, &status_tx, RemoteStatus::reconnecting(&room_id));
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            ctl = control_rx.recv() => match ctl {
                Some(ControlMsg::Token(t)) => jwt = t, // retry now with the fresh token
                Some(ControlMsg::Shutdown) | None => {
                    publish(&app, &status_tx, RemoteStatus::offline());
                    return;
                }
            },
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Build the four-token handshake and open the socket (rustls for `wss://`, plain
/// for the local `ws://` dev relay). The JWT rides as `auth.<base64url(jwt)>` — a
/// subprotocol token, not a header, since browsers can't set WS headers (§3.1).
async fn connect(relay_url: &str, jwt: &str, room_id: &str) -> Result<WsStream, String> {
    let protocols = format!(
        "{RELAY_SUBPROTOCOL}, auth.{}, room.{room_id}, role.desktop",
        URL_SAFE_NO_PAD.encode(jwt)
    );
    let request = http::Request::builder()
        .uri(relay_url)
        .header("Sec-WebSocket-Protocol", protocols)
        .body(())
        .map_err(|e| format!("build request: {e}"))?;

    let (ws, _resp) = timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(redact_ws_err)?;
    Ok(ws)
}

/// The connected event loop: split the socket, announce presence, then `select!`
/// over inbound frames, outbound frames (from the mpsc), and control messages.
async fn serve(
    app: &AppHandle,
    session: &PairingSession,
    ws: WsStream,
    jwt: &mut String,
    control_rx: &mut mpsc::Receiver<ControlMsg>,
) -> LoopEnd {
    let (mut write, mut read) = ws.split();
    // Many producers (per-chat tasks, presence) → one writer. 64 is plenty for the
    // low frame rate; back-pressure on a stuck socket is fine (we'll drop on error).
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);

    // Tell the phone the desktop is live the moment we're connected.
    if let Ok(frame) = seal(session, &RemoteMessage::desktop_online()) {
        let _ = write.send(Message::Text(frame.into())).await;
    }

    loop {
        tokio::select! {
            inbound = read.next() => match inbound {
                Some(Ok(Message::Text(txt))) => handle_frame(app, session, txt.as_str(), &out_tx),
                Some(Ok(Message::Close(_))) => return LoopEnd::Disconnected,
                // Binary isn't part of the contract; Ping/Pong are auto-handled by
                // tungstenite and the relay's auto-response — nothing to do here.
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    eprintln!("[remote] read error: {}", redact_ws_err(e));
                    return LoopEnd::Disconnected;
                }
                None => return LoopEnd::Disconnected, // stream ended
            },
            outbound = out_rx.recv() => {
                if let Some(frame) = outbound {
                    if let Err(e) = write.send(Message::Text(frame.into())).await {
                        eprintln!("[remote] write error: {}", redact_ws_err(e));
                        return LoopEnd::Disconnected;
                    }
                }
            },
            ctl = control_rx.recv() => match ctl {
                // A refreshed token is applied on the NEXT reconnect (a live socket
                // needs no re-auth — the relay only checks the JWT at the upgrade).
                Some(ControlMsg::Token(t)) => *jwt = t,
                Some(ControlMsg::Shutdown) | None => {
                    let _ = write.send(Message::Close(None)).await;
                    return LoopEnd::Shutdown;
                }
            },
        }
    }
}

/// Decrypt one inbound frame and dispatch it. A `chat` runs in its OWN spawned task
/// (so a long agentic turn never blocks the read loop) and seals its reply back onto
/// the outbound channel. Undecryptable/garbage frames are dropped (fail-closed).
fn handle_frame(app: &AppHandle, session: &PairingSession, txt: &str, out_tx: &mpsc::Sender<String>) {
    let msg = match open(session, txt) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[remote] dropped frame: {e}");
            return;
        }
    };

    match msg {
        RemoteMessage::Chat { id, text, provider, model, session_id, images } => {
            let app = app.clone();
            let session = session.clone();
            let out_tx = out_tx.clone();
            tauri::async_runtime::spawn(async move {
                let reply = run_chat_turn(&app, id, text, provider, model, session_id, images).await;
                match seal(&session, &reply) {
                    Ok(frame) => {
                        let _ = out_tx.send(frame).await;
                    }
                    Err(e) => eprintln!("[remote] failed to seal reply: {e}"),
                }
            });
        }
        // The desktop is the responder: it doesn't act on results/errors/presence it
        // receives. `HistoryRequest` replay is a Phase-4 stretch (no-op for v1).
        _ => {}
    }
}

/// Run a decrypted `chat` through the shared turn core and shape the reply. Reaches
/// the managed states through the `AppHandle` exactly as the IPC commands do, so the
/// orchestrator path is byte-identical to a local `submit_chat_message`.
async fn run_chat_turn(
    app: &AppHandle,
    id: String,
    text: String,
    provider: Option<String>,
    model: Option<String>,
    session_id: Option<String>,
    images: Vec<RemoteImage>,
) -> RemoteMessage {
    let router = app.state::<Arc<McpRouter>>();
    let db = app.state::<MemoryHandle>();
    let crypto = app.state::<CryptoState>();

    let params = TurnParams {
        user_prompt: text,
        provider,
        model,
        session_id,
        images: images.into_iter().map(|i| (i.media_type, i.data)).collect(),
    };

    match run_turn(router.inner(), db.inner(), crypto.inner(), params).await {
        Ok(r) => RemoteMessage::chat_result(id, r.text, r.tools_used, r.images),
        Err(e) => RemoteMessage::error(id, classify_turn_error(&e), e),
    }
}

/// Map a `run_turn` error string to a stable wire `code` the phone can branch on.
fn classify_turn_error(e: &str) -> &'static str {
    if e.contains("key found") {
        "no_key"
    } else {
        "turn_failed"
    }
}

/// Publish a status transition: update the watch (for `remote_status` polls) and
/// emit the Tauri event (for live panel updates). Neither carries any secret.
fn publish(app: &AppHandle, tx: &watch::Sender<RemoteStatus>, status: RemoteStatus) {
    let _ = tx.send(status.clone());
    let _ = app.emit(STATUS_EVENT, status);
}

/// Compact, secret-free description of a WebSocket failure (the token lives in the
/// request, never the error, but we still keep this terse and category-only).
fn redact_ws_err(e: WsError) -> String {
    match e {
        WsError::Http(resp) => format!("http {}", resp.status().as_u16()),
        WsError::Io(io) => format!("io {}", io.kind()),
        WsError::ConnectionClosed | WsError::AlreadyClosed => "connection closed".into(),
        other => format!("ws {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_missing_key_vs_other_failures() {
        assert_eq!(
            classify_turn_error("No anthropic key found. Add one in the BYOK panel (provider: anthropic) and try again."),
            "no_key"
        );
        assert_eq!(classify_turn_error("Anthropic API error 500: overloaded"), "turn_failed");
    }
}
