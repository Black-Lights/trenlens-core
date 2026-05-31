/**
 * Worker entrypoint — the "bouncer".
 *
 * Flow (REMOTE_ARCHITECTURE_PLAN.md §3.1 / Phase 2):
 *   1. Accept only `GET /connect` with an `Upgrade: websocket`.
 *   2. Read the `Sec-WebSocket-Protocol` offer — browsers can't set custom headers,
 *      so the JWT, pairing id, and role ride as subprotocol tokens:
 *        trenlens.relay.v1 | auth.<base64url(jwt)> | room.<pairingId> | role.<desktop|mobile>
 *   3. Verify the JWT against the Supabase JWKS (auth.ts). Invalid → 401.
 *   4. Route the upgrade to the Durable Object named `${sub}:${pairingId}` — same
 *      account + room ⇒ same instance ⇒ paired. The DO relays the rest.
 *
 * The Worker never sees plaintext payloads (those only flow over the established
 * socket, which the DO forwards as opaque ciphertext). The JWT is visible here by
 * design — the Worker is the authenticator — and is unrelated to the E2E key.
 */
import { verifyToken } from './auth';
import { RelayRoom } from './relay-room';
import type { Env, Role } from './types';

// Durable Object classes must be exported from the Worker entrypoint module.
export { RelayRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/connect') {
      return new Response('not found', { status: 404 });
    }
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const offered = parseSubprotocols(request.headers.get('Sec-WebSocket-Protocol'));
    const tokenB64 = stripPrefix(offered, 'auth.');
    const pairingId = stripPrefix(offered, 'room.');
    const role = parseRole(stripPrefix(offered, 'role.'));

    if (!tokenB64 || !pairingId || !role) {
      return new Response('missing auth / room / role subprotocol', { status: 400 });
    }

    let sub: string;
    try {
      sub = (await verifyToken(b64urlToString(tokenB64), env)).sub;
    } catch {
      // Deliberately opaque: don't leak whether it was signature, exp, iss, or aud.
      return new Response('unauthorized', { status: 401 });
    }

    // Deterministic name → the desktop and phone(s) of this account+room converge
    // on one DO instance. Different sub or different pairingId ⇒ a different room.
    const roomName = `${sub}:${pairingId}`;
    const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(roomName));

    // Pass the (non-secret) role to the DO via the forwarded URL; the upgrade and
    // headers are carried through unchanged.
    const doUrl = new URL(request.url);
    doUrl.searchParams.set('role', role);
    return stub.fetch(new Request(doUrl, request));
  },
};

/** Split a `Sec-WebSocket-Protocol` header into trimmed, non-empty tokens. */
function parseSubprotocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** First offered subprotocol with `prefix`, with the prefix removed (or null). */
function stripPrefix(list: string[], prefix: string): string | null {
  const hit = list.find((p) => p.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function parseRole(value: string | null): Role | null {
  return value === 'desktop' || value === 'mobile' ? value : null;
}

/** Decode an unpadded base64url string to UTF-8 (the JWT). */
function b64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
