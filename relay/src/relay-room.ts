/**
 * RelayRoom — the stateful, blind coordination point for one pairing.
 *
 * Addressed by `idFromName(`${user_id}:${pairingId}`)`, so the desktop and the
 * phone(s) of the SAME account + QR land on the SAME instance — that addressing
 * *is* the pairing. The room never reads payloads: `webSocketMessage` forwards the
 * frame verbatim to the peer(s). The only plaintext it ever sees is metadata.
 *
 * Hibernation API: we accept sockets with `ctx.acceptWebSocket(ws, [role])` so the
 * runtime can evict the DO from memory between frames while keeping connections
 * open (near-zero idle cost). Per-socket role is tagged for `getWebSockets(tag)`
 * and mirrored into `serializeAttachment` so it survives hibernation.
 *
 * Routing policy (REMOTE_ARCHITECTURE_PLAN.md Phase 2 / decision #3):
 *   - exactly 1 desktop + N mobiles; a newer desktop REPLACES the old one,
 *   - hub topology: mobile → desktop(s), desktop → mobile(s); never mobile↔mobile.
 */
import { DurableObject } from 'cloudflare:workers';

import type { Env, Role, SocketMeta } from './types';

/** The version tag echoed back as the negotiated subprotocol (see index.ts §3.1). */
const RELAY_SUBPROTOCOL = 'trenlens.relay.v1';

/** Anti-abuse: drop oversized frames (the E2E envelope is small; images are chunked). */
const MAX_FRAME_BYTES = 512 * 1024;

/** Close codes (4000–4999 are application-defined). */
const CLOSE_REPLACED = 4002;

export class RelayRoom extends DurableObject<Env> {
  /** Handle the upgrade forwarded by the Worker. `?role=` was set after JWT verify. */
  async fetch(request: Request): Promise<Response> {
    const role: Role =
      new URL(request.url).searchParams.get('role') === 'desktop' ? 'desktop' : 'mobile';

    // "Newest desktop wins": evict any existing desktop before accepting a new one,
    // so a re-paired/relaunched desktop cleanly takes over the room.
    if (role === 'desktop') {
      for (const old of this.ctx.getWebSockets('desktop')) {
        try {
          old.close(CLOSE_REPLACED, 'replaced by a newer desktop');
        } catch {
          /* already closing */
        }
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // Hibernatable accept, tagged by role so getWebSockets(role) can target peers.
    this.ctx.acceptWebSocket(server, [role]);
    const meta: SocketMeta = { role, connectedAt: Date.now() };
    server.serializeAttachment(meta);

    // Cheap liveness without waking the relay: a literal "ping" → "pong" handled by
    // the runtime (these frames are NOT forwarded to peers). Clients may also use
    // protocol-level pings. "ping"/"pong" are therefore reserved control strings.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL },
    });
  }

  /** Blind relay: forward the frame verbatim to the opposite side. No parsing, no logs. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      try {
        ws.close(1009, 'frame too large');
      } catch {
        /* noop */
      }
      return;
    }

    const meta = ws.deserializeAttachment() as SocketMeta | null;
    const fromRole: Role = meta?.role ?? 'mobile';
    const toRole: Role = fromRole === 'desktop' ? 'mobile' : 'desktop';

    for (const peer of this.ctx.getWebSockets(toRole)) {
      try {
        peer.send(message);
      } catch {
        /* peer mid-close; drop */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // The runtime removes the socket from getWebSockets() after this returns; we only
    // need to finalize the close. (No cross-frame state to persist.)
    try {
      ws.close(code <= 1000 || code >= 5000 ? 1000 : code, 'peer closed');
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, 'socket error');
    } catch {
      /* already closed */
    }
  }
}
