#!/usr/bin/env node
/**
 * Phase 2 validation for the TrenLens relay.
 *
 * Assumes:
 *   - local Supabase is running (`supabase start`),
 *   - the relay is running locally (`npm run dev` in relay/, default :8787).
 *
 * Exercises the four guarantees of the blind relay:
 *   1. AUTH      — a bad/absent JWT is rejected at the handshake (no pairing).
 *   2. PAIRING   — same account + room ⇒ desktop and mobile are connected.
 *   3. RELAY     — frames are forwarded verbatim, both directions (blind).
 *   4. ISOLATION — a different room (same account) never sees the frames.
 *   5. POLICY    — a newer desktop replaces the old one (close code 4002).
 *
 * Uses Node 22's global WebSocket + fetch (no deps). Exits non-zero on failure.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => `room_${Math.random().toString(36).slice(2, 10)}`;

/** Sign in (or sign up) the test user via the Supabase Auth REST API. */
async function getToken() {
  const headers = { apikey: ANON_KEY, 'content-type': 'application/json' };
  let res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
  }
  if (!res.ok) throw new Error(`token fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/** Open a relay socket; returns a handle with an inbox + lifecycle promises. */
function connect({ token, room, role }) {
  const protocols = [
    'trenlens.relay.v1',
    `auth.${b64url(token)}`,
    `room.${room}`,
    `role.${role}`,
  ];
  const ws = new WebSocket(RELAY_URL, protocols);
  const h = { ws, inbox: [], opened: false, closed: null, errored: false };
  h.ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      h.opened = true;
      resolve(h);
    });
    ws.addEventListener('error', () => {
      h.errored = true;
      reject(new Error('handshake failed'));
    });
  });
  ws.addEventListener('message', (e) => h.inbox.push(typeof e.data === 'string' ? e.data : '[bin]'));
  ws.addEventListener('close', (e) => (h.closed = { code: e.code, reason: e.reason }));
  return h;
}

async function waitForInbox(h, n = 1, ms = 1500) {
  const t0 = Date.now();
  while (h.inbox.length < n && Date.now() - t0 < ms) await sleep(25);
  return h.inbox.length >= n;
}
async function waitForClose(h, ms = 1500) {
  const t0 = Date.now();
  while (!h.closed && Date.now() - t0 < ms) await sleep(25);
  return h.closed;
}

async function main() {
  console.log(`• Supabase : ${SUPABASE_URL}`);
  console.log(`• Relay    : ${RELAY_URL}\n`);
  const token = await getToken();

  // ── 1. AUTH: a garbage token must be rejected at the handshake ──────────────
  console.log('[1] auth rejection');
  {
    const room = rid();
    const h = connect({ token: 'not.a.valid.jwt', room, role: 'mobile' });
    try {
      await h.ready;
      bad('a bad token was ACCEPTED (should have been rejected)');
      try { h.ws.close(); } catch {}
    } catch {
      ok('bad token rejected at the handshake (401)');
    }
  }

  // ── 2+3. PAIRING + RELAY (both directions) ──────────────────────────────────
  console.log('[2+3] pairing + blind relay');
  const room = rid();
  const desktop = connect({ token, room, role: 'desktop' });
  const mobile = connect({ token, room, role: 'mobile' });
  try {
    await Promise.all([desktop.ready, mobile.ready]);
    ok('desktop + mobile both connected to the same room');
  } catch {
    bad('failed to establish the paired sockets');
  }
  // negotiated subprotocol must be the version tag
  if (desktop.ws.protocol === 'trenlens.relay.v1') ok('negotiated subprotocol = trenlens.relay.v1');
  else bad(`unexpected negotiated subprotocol: "${desktop.ws.protocol}"`);

  const up = JSON.stringify({ iv: 'AAAA', ct: 'phone-to-desktop' });
  mobile.ws.send(up);
  if ((await waitForInbox(desktop)) && desktop.inbox[0] === up) ok('mobile → desktop forwarded verbatim');
  else bad(`mobile → desktop not relayed (got ${JSON.stringify(desktop.inbox)})`);

  const down = JSON.stringify({ iv: 'BBBB', ct: 'desktop-to-phone' });
  desktop.ws.send(down);
  if ((await waitForInbox(mobile)) && mobile.inbox[0] === down) ok('desktop → mobile forwarded verbatim');
  else bad(`desktop → mobile not relayed (got ${JSON.stringify(mobile.inbox)})`);

  // ── 4. ISOLATION: a different room (same account) sees nothing ───────────────
  console.log('[4] room isolation');
  const otherRoom = rid();
  const otherMobile = connect({ token, room: otherRoom, role: 'mobile' });
  await otherMobile.ready.catch(() => {});
  desktop.ws.send(JSON.stringify({ iv: 'CCCC', ct: 'should-not-leak' }));
  await sleep(400);
  if (otherMobile.inbox.length === 0) ok('a different room received nothing (rooms are isolated)');
  else bad(`isolation breach: other room saw ${JSON.stringify(otherMobile.inbox)}`);

  // ── 5. POLICY: newest desktop wins ──────────────────────────────────────────
  console.log('[5] newest-desktop-wins');
  const desktop2 = connect({ token, room, role: 'desktop' });
  await desktop2.ready.catch(() => {});
  const closed = await waitForClose(desktop, 2000);
  if (closed && closed.code === 4002) ok(`first desktop evicted with code 4002 ("${closed.reason}")`);
  else bad(`first desktop not evicted as expected (closed=${JSON.stringify(closed)})`);

  // cleanup
  for (const h of [desktop, mobile, otherMobile, desktop2]) {
    try { h.ws.close(); } catch {}
  }
  await sleep(150);

  console.log(`\n${failures === 0 ? '✅ Phase 2 relay validated.' : `❌ ${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n❌ test harness error: ${e.message}`);
  process.exit(1);
});
