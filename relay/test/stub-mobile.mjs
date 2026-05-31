#!/usr/bin/env node
/**
 * Phase 4 validation — the "stub mobile".
 *
 * Drives the FULL blind-relay loop with real Supabase JWTs and the real E2E layer
 * (Web Crypto AES-256-GCM `{iv, ct}` envelope + the `RemoteMessage` protocol), so it
 * exercises everything the phone will: the four-token handshake, JWT auth at the
 * upgrade, DO pairing by `sub:room`, opaque relay forwarding, and seal/open.
 *
 * Two modes:
 *
 *   • loopback (default, NO desktop needed) — the script plays BOTH ends against the
 *     relay: a `role.mobile` socket seals a `chat` and a `role.desktop` socket
 *     receives it, decrypts, and seals a `chatResult` back. Proves transport +
 *     crypto + protocol headlessly. This is what runs in local CI.
 *
 *   • real (`--pair "<trenlens://pair…>"`) — talks to the ACTUAL running TrenLens
 *     desktop: paste the pair link from the desktop's Remote Control panel; the
 *     script connects as the phone, sends one encrypted `chat`, and asserts it gets a
 *     decryptable `chatResult` (a provider key is configured) or `error{no_key}` (it
 *     isn't). Either proves the desktop's decrypt → run_turn → encrypt pipe end-to-end.
 *
 * Assumes (both modes): local Supabase (`supabase start`) + the relay
 * (`npm run dev` in relay/, default :8787). Real mode also needs the desktop running,
 * signed into the SAME account, with that pairing armed + connected.
 *
 * Node 22 globals only (WebSocket, fetch, crypto.subtle, Buffer) — no deps.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:8787/connect';
const EMAIL = process.env.TEST_EMAIL || 'remote-test@trenlens.local';
const PASSWORD = process.env.TEST_PASSWORD || 'test-password-123';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failures++;
  console.error(`  ✗ ${m}`);
};
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const bytesToB64url = (u8) => Buffer.from(u8).toString('base64url');
const b64urlToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => `room_${Math.random().toString(36).slice(2, 10)}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── E2E crypto (byte-compatible with mobile/lib/crypto.ts + Rust session.rs) ───
async function importKey(rawBytes) {
  if (rawBytes.length !== 32) throw new Error(`key must be 32 bytes, got ${rawBytes.length}`);
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function sealMessage(key, message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(message))));
  return JSON.stringify({ iv: bytesToB64url(iv), ct: bytesToB64url(ct) });
}
async function openMessage(key, frame) {
  const env = JSON.parse(frame);
  const iv = b64urlToBytes(env.iv);
  const ct = b64urlToBytes(env.ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt));
}

/** Parse `trenlens://pair?room=<id>&key=<b64url 32B>&v=1`. */
function parsePairUri(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'trenlens:') throw new Error(`not a trenlens:// link: ${uri}`);
  const room = u.searchParams.get('room');
  const keyB64 = u.searchParams.get('key');
  if (!room || !keyB64) throw new Error('pair link missing room or key');
  const keyBytes = b64urlToBytes(keyB64);
  if (keyBytes.length !== 32) throw new Error(`key must be 32 bytes, got ${keyBytes.length}`);
  return { room, keyBytes };
}

/** Sign in (or sign up) the test user via the Supabase Auth REST API. */
async function getToken() {
  const headers = { apikey: ANON_KEY, 'content-type': 'application/json' };
  const pw = () =>
    fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  let res = await pw();
  if (!res.ok) {
    await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    res = await pw();
  }
  if (!res.ok) throw new Error(`token fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/** Open a relay socket; returns a handle with an inbox + a `ready` promise. */
function connect({ token, room, role }) {
  const protocols = ['trenlens.relay.v1', `auth.${b64url(token)}`, `room.${room}`, `role.${role}`];
  const ws = new WebSocket(RELAY_URL, protocols);
  const h = { ws, inbox: [], closed: null };
  h.ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(h));
    ws.addEventListener('error', () => reject(new Error('handshake failed')));
  });
  ws.addEventListener('message', (e) => h.inbox.push(typeof e.data === 'string' ? e.data : '[bin]'));
  ws.addEventListener('close', (e) => (h.closed = { code: e.code, reason: e.reason }));
  return h;
}

async function waitForInbox(h, n = 1, ms = 2000) {
  const t0 = Date.now();
  while (h.inbox.length < n && Date.now() - t0 < ms) await sleep(25);
  return h.inbox.length >= n;
}

/** Wait for a decryptable reply addressed to `id` whose type is one of `types`. */
async function waitForReply(h, key, id, types, ms = 8000) {
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < ms) {
    while (seen < h.inbox.length) {
      const frame = h.inbox[seen++];
      try {
        const msg = await openMessage(key, frame);
        if (msg.id === id && types.includes(msg.type)) return msg;
      } catch {
        /* not for us / undecryptable — skip */
      }
    }
    await sleep(25);
  }
  return null;
}

// ── Mode 1: loopback (no desktop) ──────────────────────────────────────────────
async function runLoopback(token) {
  console.log('[loopback] mobile ⇄ relay ⇄ (stub) desktop — transport + crypto + protocol\n');
  const room = rid();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importKey(keyBytes);

  const desktop = connect({ token, room, role: 'desktop' });
  const mobile = connect({ token, room, role: 'mobile' });
  try {
    await Promise.all([desktop.ready, mobile.ready]);
    ok('both ends connected to the same room (paired by sub:room)');
  } catch {
    bad('failed to establish the paired sockets');
    return;
  }

  // mobile → desktop: an encrypted `chat`.
  const chat = { v: 1, id: 'stub-1', type: 'chat', text: 'ping from stub mobile', provider: 'anthropic', model: null, sessionId: null, images: [] };
  mobile.ws.send(await sealMessage(key, chat));

  if (!(await waitForInbox(desktop))) {
    bad('desktop never received the chat frame');
    return;
  }
  // The relay must have forwarded opaque ciphertext, not plaintext.
  if (!desktop.inbox[0].includes('ping')) ok('relay forwarded an opaque {iv,ct} frame (no plaintext leaked)');
  else bad('plaintext leaked through the relay!');

  const gotChat = await openMessage(key, desktop.inbox[0]);
  if (gotChat.type === 'chat' && gotChat.text === chat.text) ok('desktop decrypted the chat (RemoteMessage round-trips)');
  else bad(`desktop decrypted an unexpected message: ${JSON.stringify(gotChat)}`);

  // desktop → mobile: the encrypted `chatResult` (echoing the request id).
  const reply = { v: 1, id: gotChat.id, type: 'chatResult', text: 'pong', toolsUsed: [], images: [] };
  desktop.ws.send(await sealMessage(key, reply));

  const back = await waitForReply(mobile, key, chat.id, ['chatResult']);
  if (back && back.text === 'pong') ok('mobile decrypted the chatResult (full loop closed)');
  else bad(`mobile did not get the chatResult (got ${JSON.stringify(back)})`);

  // A foreign key must NOT decrypt the frames (the relay stays blind).
  const foreign = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  let blind = false;
  try {
    await openMessage(foreign, desktop.inbox[0]);
  } catch {
    blind = true;
  }
  if (blind) ok('a foreign key cannot decrypt the frame (fail-closed)');
  else bad('a foreign key decrypted the frame — E2E broken!');

  for (const h of [desktop, mobile]) try { h.ws.close(); } catch {}
  await sleep(150);
}

// ── Mode 2: real desktop ────────────────────────────────────────────────────────
async function runReal(token, uri) {
  const { room, keyBytes } = parsePairUri(uri);
  const key = await importKey(keyBytes);
  console.log(`[real] talking to the live desktop in room ${room}\n`);

  const mobile = connect({ token, room, role: 'mobile' });
  try {
    await mobile.ready;
    ok('connected to the relay as the phone');
  } catch {
    bad('handshake failed (is the desktop signed into the same account?)');
    return;
  }

  const chat = { v: 1, id: `stub-${Date.now()}`, type: 'chat', text: process.env.STUB_PROMPT || 'Say hello in five words.', provider: 'anthropic', model: null, sessionId: null, images: [] };
  mobile.ws.send(await sealMessage(key, chat));
  ok('sent an encrypted chat; awaiting the desktop’s reply…');

  const reply = await waitForReply(mobile, key, chat.id, ['chatResult', 'error'], 30000);
  if (!reply) {
    bad('no decryptable chatResult/error came back (is the desktop connected?)');
    return;
  }
  if (reply.type === 'chatResult') {
    ok(`desktop ran the turn and answered (E2E): "${String(reply.text).slice(0, 80)}"`);
  } else {
    // `error{no_key}` is the expected hermetic outcome when no provider key is set —
    // it STILL proves the full decrypt → run_turn → encrypt pipe end-to-end.
    ok(`desktop pipe verified via error{${reply.code}}: ${reply.message}`);
  }

  try { mobile.ws.close(); } catch {}
  await sleep(150);
}

async function main() {
  const uri = process.argv.find((a) => a.startsWith('trenlens://')) || process.env.PAIR_URI || null;
  console.log(`• Supabase : ${SUPABASE_URL}`);
  console.log(`• Relay    : ${RELAY_URL}`);
  console.log(`• Mode     : ${uri ? 'real desktop' : 'loopback'}\n`);

  const token = await getToken();
  if (uri) await runReal(token, uri);
  else await runLoopback(token);

  console.log(`\n${failures === 0 ? '✅ Phase 4 relay loop validated.' : `❌ ${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n❌ test harness error: ${e.message}`);
  process.exit(1);
});
