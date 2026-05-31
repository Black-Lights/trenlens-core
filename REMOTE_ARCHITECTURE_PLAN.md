# TrenLens Remote Control — Architecture & Execution Plan

> **Status:** PLANNING ONLY. No implementation code is written yet. This document
> is the contract we build against, phase by phase. Work begins on Phase 1 only
> on explicit instruction.
>
> **Feature:** control the local TrenLens desktop engine from a phone while away
> from the keyboard, via an **Authenticated Blind Relay**.
>
> **Companion doc:** `RESEARCH_AND_GUIDELINES.md` (the core app). Section refs of
> the form *§5 (crypto)* point there. This plan adds a new top-level subsystem and
> reuses the existing crypto (§5), orchestrator, memory (§4), and IPC (§10) layers.

---

## 0. The idea in one paragraph

The phone never talks to the desktop directly and never punches through a NAT. A
tiny stateless **Cloudflare Worker + Durable Object** sits in the middle as a
*bouncer*: it authenticates each socket with a **Supabase JWT**, then pairs the
desktop and the phone **only when they present a token for the same `user_id`**.
Everything the bouncer forwards is **AES-256-GCM ciphertext** it cannot read — the
symmetric key is generated on the desktop, shown as a **QR code**, scanned by the
phone, and never leaves either device. Decrypted commands on the desktop are piped
straight into the existing Rust **orchestrator** (`orchestrator/mod.rs`), so the
phone gets the *exact* same tool-using assistant the desktop user gets.

Three trust boundaries, each independently enforced:

| Boundary | Mechanism | Threat it stops |
|---|---|---|
| *Who are you?* | Supabase JWT, signature-verified at the edge | Strangers connecting to the relay |
| *Who do I pair you with?* | Durable Object keyed by `user_id` + pairing id | Cross-account / cross-device crosstalk |
| *What can the relay read?* | E2E AES-256-GCM, key exchanged out-of-band via QR | A compromised/curious relay reading chats |

---

## 1. System overview

### 1.1 Components

```
┌──────────────────────────────┐                         ┌──────────────────────────────┐
│  DESKTOP (existing app)       │                         │  MOBILE (new PWA)             │
│  Tauri v2 — Rust + Next.js    │                         │  Next.js, mobile-first        │
│                               │                         │                               │
│  Next.js webview:             │                         │  • Supabase login             │
│   • Supabase login            │                         │  • Camera QR scan             │
│   • generates + renders QR    │                         │  • WebCrypto AES-GCM decrypt  │
│   • hands JWT to Rust (IPC)   │                         │  • chat timeline (read/send)  │
│                               │                         │                               │
│  Rust backend (NEW: remote/): │                         │      browser WebSocket        │
│   • tokio-tungstenite client  │                         │             │                 │
│   • holds ephemeral AES key   │                         │             │                 │
│   • AES-GCM encrypt/decrypt   │                         │             │                 │
│   • pipes → orchestrator      │                         │             │                 │
└──────────────┬───────────────┘                         └─────────────┬─────────────────┘
               │ wss:// (JWT in Sec-WebSocket-Protocol)                 │ wss:// (JWT in subprotocol)
               │ frames = AES-GCM ciphertext                            │ frames = AES-GCM ciphertext
               ▼                                                        ▼
        ┌───────────────────────────────────────────────────────────────────────┐
        │  CLOUDFLARE WORKER (the "bouncer")                                      │
        │   • verifies JWT against Supabase JWKS (jose, WebCrypto, at the edge)   │
        │   • extracts sub (= user_id), routes to Durable Object by user_id+room  │
        ├───────────────────────────────────────────────────────────────────────┤
        │  DURABLE OBJECT  "RelayRoom"  (one per user_id:pairingId)               │
        │   • holds the desktop socket + phone socket(s) (Hibernation API)        │
        │   • BLIND relay: forwards opaque ciphertext frames between them         │
        │   • never has the AES key — cannot read payloads                        │
        └───────────────────────────────────────────────────────────────────────┘
                          ▲                                   ▲
                          └────────── IDENTITY: Supabase Auth ─┘
                       (local: supabase CLI / Docker; prod: Supabase Cloud)
                        JWKS at /auth/v1/.well-known/jwks.json
```

### 1.2 Why each architectural choice

- **Relay instead of P2P.** A phone on cellular and a desktop behind a home router
  cannot reliably reach each other. WebRTC/STUN/TURN would solve NAT traversal but
  adds an ICE/signalling stack and a TURN fallback that is itself a relay. A
  WebSocket relay is simpler, always works, and — once we add E2E encryption — is
  no less private than TURN.
- **Cloudflare Worker + Durable Object.** A *stateless* Worker cannot hold two
  long-lived sockets and shuttle bytes between them; relaying needs a single
  stateful coordination point. A **Durable Object** is exactly that: a
  single-threaded, addressable actor. We key it by `user_id` so both of a user's
  devices deterministically land on the **same instance** (`getByName(user_id)`),
  which *is* the pairing mechanism. The **Hibernation API** lets the DO evict from
  memory between messages while keeping sockets open — near-zero cost while idle.
- **JWT in `Sec-WebSocket-Protocol`.** Browsers' `WebSocket` constructor cannot set
  arbitrary request headers (no `Authorization`). The one header the browser *does*
  let us influence is `Sec-WebSocket-Protocol` (the subprotocol list). The
  established pattern — used by Kubernetes' API server, among others — is to smuggle
  the bearer token there. We adopt it on both clients so the Rust and browser paths
  are identical.
- **E2E via QR.** The relay authenticates identity but must not read content. A
  symmetric key generated on the desktop and transferred by QR never transits the
  network, so the relay is cryptographically blind. AES-256-GCM is already the
  app's sealing primitive (§5), and the browser's Web Crypto `AES-GCM` is
  byte-compatible with Rust's `aes-gcm` crate — no custom crypto, no new algorithm.

### 1.3 The message lifecycle (happy path)

```
Phone composer "what's on my calendar today?"
   │  (1) plaintext command JSON
   ▼
WebCrypto AES-GCM encrypt  → { iv, ct }
   │  (2) opaque frame
   ▼
WS send ──► Cloudflare Worker (already-authenticated socket) ──► RelayRoom DO
   │  (3) DO forwards the SAME bytes to the *other* socket (the desktop)
   ▼
Desktop Rust client receives { iv, ct }
   │  (4) aes-gcm decrypt → plaintext command JSON
   ▼
orchestrator::run_chat(router, provider, key, model, history, prompt, images)
   │  (5) same agentic tool loop the desktop user gets
   ▼
ChatResult { text, toolsUsed, images }
   │  (6) AES-GCM encrypt → { iv, ct }
   ▼
WS send ──► DO ──► phone ──► WebCrypto decrypt ──► render in timeline
```

The relay sees steps (3) only, as ciphertext. It never sees plaintext at any step.

---

## 2. Repository topology & deliverable layout

The relay and the mobile PWA are **separate deployables** from the desktop app, but
we keep them in-repo (monorepo-style) so the wire contract stays in one place.

```
trenlens-core/
├─ src-tauri/src/
│  ├─ orchestrator/mod.rs        # (existing) integration target — Phase 4 calls run_chat
│  ├─ crypto/mod.rs              # (existing §5) AES-256-GCM — Phase 3 reuses the primitive
│  ├─ commands.rs                # (existing §10) + NEW remote_* IPC commands (Phase 4)
│  ├─ lib.rs                     # (existing) + manage(RemoteState), wire new commands
│  └─ remote/                    # ★ NEW Rust module (Phase 4)
│     ├─ mod.rs                  #   RemoteState, lifecycle, public IPC-facing API
│     ├─ client.rs               #   tokio-tungstenite connect/read/write loop + reconnect
│     ├─ session.rs              #   ephemeral AES key, pairing id, envelope encode/decode
│     └─ protocol.rs             #   wire types (RemoteEnvelope, RemoteMessage) — shared shapes
│
├─ src/                          # (existing) desktop Next.js — Phase 1 adds Supabase + QR UI
│  ├─ lib/supabase.ts            # ★ NEW supabase-js client (desktop)
│  ├─ lib/remote.ts              # ★ NEW IPC wrappers for remote_* commands
│  └─ components/remote/         # ★ NEW "Enable Remote Control" panel + QR display
│
├─ relay/                        # ★ NEW Cloudflare Worker (Phase 2) — own wrangler project
│  ├─ src/index.ts               #   fetch handler: JWT verify + route to DO
│  ├─ src/relay-room.ts          #   RelayRoom Durable Object (Hibernation API)
│  ├─ src/auth.ts                #   jose JWKS verification
│  ├─ wrangler.jsonc             #   DO binding + new_sqlite_classes migration + vars
│  └─ package.json               #   jose, wrangler, @cloudflare/workers-types
│
├─ mobile/                       # ★ NEW Next.js PWA (Phase 5) — deploy to Cloudflare Pages
│  ├─ app/                       #   login, scan, chat routes (App Router)
│  ├─ lib/{supabase,crypto,ws}.ts#   supabase-js, WebCrypto AES-GCM, WebSocket transport
│  ├─ public/manifest.webmanifest + icons + service worker
│  └─ package.json
│
├─ supabase/                     # ★ NEW (Phase 1) — supabase init output (safe to commit)
│  └─ config.toml
│
└─ REMOTE_ARCHITECTURE_PLAN.md   # this file
```

> **Decision — separate `mobile/` app, not a route in `src/`.** The desktop frontend
> is statically exported into the Tauri bundle (`output: 'export'`, `dist/`). The PWA
> must be served over HTTPS from a real origin (camera `getUserMedia` and service
> workers require a secure context, and SWs must be served from the domain root, not
> via a redirect). Bolting it onto the Tauri-targeted export would entangle two
> incompatible build targets. A small dedicated Next.js app deployed to Cloudflare
> Pages is cleaner and shares only the TypeScript wire types.

---

## 3. Cross-cutting contracts (define once, both ends obey)

These are frozen *before* any phase ships, because every phase depends on them.

### 3.1 The WebSocket handshake contract

Both clients (Rust desktop, browser phone) open `wss://<relay-host>/connect` and
offer these `Sec-WebSocket-Protocol` values, comma-separated:

| Subprotocol offered | Meaning | Secret? |
|---|---|---|
| `trenlens.relay.v1` | protocol version tag; the Worker **echoes this one back** | no |
| `auth.<base64url(jwt)>` | the Supabase access token | bearer token (TLS-protected) |
| `room.<pairingId>` | the pairing id from the QR (scopes the DO room) | no (key is the secret) |
| `role.desktop` / `role.mobile` | which side this socket is | no |

- The Worker **must** respond to the 101 with `Sec-WebSocket-Protocol:
  trenlens.relay.v1` (echoing exactly one offered, non-sensitive value) or browsers
  abort the connection.
- `base64url` is **unpadded** (RFC 4648 §5) so the value is header-safe.
- The JWT is visible to Cloudflare (TLS terminates there) and to the Worker — by
  design; the Worker *is* the authenticator. It is **not** visible to the DO logic
  beyond the verified claims, and is unrelated to the E2E key.

### 3.2 The encrypted envelope (what crosses the wire)

The relay forwards **opaque text frames**. The entire application message — including
its `type` — lives inside the ciphertext, so the relay learns nothing but frame size
and timing.

```jsonc
// One WebSocket text frame:
{
  "iv": "<base64url 12-byte AES-GCM nonce>",
  "ct": "<base64url AES-GCM ciphertext WITH appended 16-byte tag>"
}
```

`ct` decrypts to a `RemoteMessage`:

```jsonc
// chat command  (phone → desktop)
{ "v": 1, "id": "<ulid>", "type": "chat",
  "text": "what's on my calendar today?",
  "provider": "anthropic", "model": null, "sessionId": "<conversation id|null>",
  "images": [{ "mediaType": "image/png", "data": "<base64>" }] }

// chat result   (desktop → phone)
{ "v": 1, "id": "<same ulid>", "type": "chatResult",
  "text": "You have 3 events…", "toolsUsed": ["list_events"], "images": ["data:…"] }

// streaming chunk (optional, desktop → phone)  — see §Phase 4 streaming note
{ "v": 1, "id": "<ulid>", "type": "chunk", "delta": "You have 3 " }

// history request/response (phone ↔ desktop, optional)
{ "v": 1, "id": "<ulid>", "type": "historyRequest", "sessionId": "…", "limit": 50 }
{ "v": 1, "id": "<ulid>", "type": "history", "messages": [ {role, content}, … ] }

// presence / control (either direction)
{ "v": 1, "id": "<ulid>", "type": "presence", "role": "desktop", "online": true }
{ "v": 1, "id": "<ulid>", "type": "error", "code": "no_key", "message": "…" }
```

- `id` is a client-generated ULID used to correlate a result with its command.
- The AES-GCM **nonce (`iv`) is fresh per frame** (random 96-bit), mirroring §5's
  per-call nonce rule — never reuse a (key, nonce) pair.
- Frame layout deliberately matches the Rust `crypto/mod.rs` blob shape conceptually
  (random 12-byte nonce + ciphertext+tag); the only difference is we send `iv`/`ct`
  as two fields instead of one concatenated blob, because the browser side wants the
  IV separate when calling `crypto.subtle.decrypt`.

### 3.3 The QR pairing payload

The desktop renders a QR encoding a single URI (compact, parseable, future-proof):

```
trenlens://pair?room=<pairingId>&k=<base64url 32-byte AES key>&v=1
```

- `room` (`pairingId`): a random, non-secret id (e.g. ULID) generated per pairing
  session. Scopes the DO room to `user_id:pairingId` so a user with two desktops
  doesn't merge rooms.
- `k`: the raw 32-byte AES-256 key, base64url. **This is the only secret in the QR**
  — it never touches the network.
- The relay host is **not** in the QR; both apps read it from build/config so a
  leaked QR photo reveals only a key+room, useless without a same-account JWT *and*
  an open room.
- The QR is short-lived: the room is only "armed" while the desktop pairing panel is
  open / for a bounded TTL (see Phase 3), after which a new key must be generated.

---

## 4. Phase plan

Each phase is independently testable and leaves the app shippable (the feature is
behind an explicit "Enable Remote Control" toggle until Phase 6 hardening).

> **Dependency order:** 1 → 2 → 3 → 4 → 5 → 6. Phases 2 and 3's *design* can overlap,
> but Phase 4 (desktop client) needs the relay (2) and the key/envelope (3) to talk
> to, and Phase 5 (mobile) needs all of 1–4 to talk to something real.

---

### Phase 1 — Identity Layer (Supabase)

**Goal:** a single Supabase project (local for dev, Cloud for prod) where a user can
log in on *both* desktop and mobile, yielding a JWT whose `sub` claim is the shared
`user_id` the relay pairs on.

**1.1 Local stack (Supabase CLI + Docker)**
- Prereq: Docker Desktop running. Install the CLI via Scoop on Windows
  (`scoop install supabase`) — note `npm i -g supabase` is explicitly unsupported.
- `supabase init` → creates `supabase/config.toml` (commit it).
- `supabase start` → boots Postgres, **Auth (GoTrue)**, Storage, Realtime, Studio,
  and the API gateway in Docker. First run pulls images (slow). Outputs local creds:
  - API URL: `http://localhost:54321`
  - Studio: `http://localhost:54323`
  - `anon` key and `service_role` key
  - JWT secret (local) / signing keys
- `supabase stop` to tear down without wiping data.

**1.2 Auth configuration**
- Enable **email/password** (simplest for two-device login). Optionally a magic-link
  / OAuth provider later — not required for v1.
- **JWT signing keys.** Production Supabase projects created after **2025-10-01** use
  **asymmetric** signing keys (RS256 by default; ECC/Ed25519 optional) and expose the
  public key at `/<project>/auth/v1/.well-known/jwks.json`. This lets the relay verify
  signatures **at the edge with WebCrypto, with no call back to Supabase**. For local
  dev, enable signing keys in `config.toml` so the local JWKS endpoint matches prod;
  document the legacy HS256 shared-secret fallback for older setups (the Worker can
  support both via an env switch — see Phase 2).
- Record the **issuer** (`iss`) and **audience** (`aud`, usually `authenticated`) so
  the Worker can pin them in `jwtVerify`.

**1.3 Client SDK wiring (both apps)**
- Add `@supabase/supabase-js` to the desktop (`src/`) and mobile (`mobile/`) apps.
- `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)` with `auth.persistSession: true`.
- Desktop: a small login affordance in the Remote panel; on session, read
  `session.access_token` and pass it to Rust (Phase 4 IPC). Subscribe to
  `supabase.auth.onAuthStateChange` to push refreshed tokens before the ~1h expiry.
- Mobile: full login screen (Phase 5).

**Packages (npm):** `@supabase/supabase-js`.
**Tooling:** `supabase` CLI, Docker Desktop.

**Deliverables:** `supabase/config.toml`; documented local creds & JWKS URL;
`src/lib/supabase.ts`; a manual check that the same account logs in on two clients
and both decode a JWT with the same `sub`.

**Acceptance criteria:**
- `supabase start` yields a working Auth server and a reachable JWKS endpoint.
- A signed-in client produces a JWT that verifies against that JWKS, with `sub`,
  `iss`, `aud`, `exp` present.
- The same credentials on a second client produce a JWT with an **identical `sub`**.

**Out of scope this phase:** the relay, any sockets, any encryption.

---

### Phase 2 — Relay Layer (Cloudflare Worker + Durable Object)

**Goal:** a deployed *bouncer* that accepts a WebSocket upgrade, verifies the JWT,
and relays opaque frames between same-`user_id` sockets — reading nothing.

**2.1 Worker `fetch` handler (`relay/src/index.ts`)**
1. Accept only `GET /connect` with `Upgrade: websocket`; else `426`/`400`.
2. Parse `Sec-WebSocket-Protocol`; extract `auth.<jwt>` and `room.<pairingId>`
   (§3.1). Missing/malformed → `401`.
3. **Verify the JWT** (`relay/src/auth.ts`): `jwtVerify(token, JWKS, { issuer, audience })`
   where `JWKS = createRemoteJWKSet(new URL(SUPABASE_JWKS_URL))`. `jose` runs on
   Workers' native WebCrypto and caches keys in memory; the JWKS is additionally
   edge-cached ~10 min, so the common path costs no network call. Invalid/expired →
   `401`. (Env switch `JWT_MODE = jwks | hs256` to support local legacy secrets.)
4. Derive the room name: `roomName = `${claims.sub}:${pairingId}``.
5. `const id = env.RELAY_ROOM.idFromName(roomName); const stub = env.RELAY_ROOM.get(id);`
   then `return stub.fetch(request)` — handing the upgrade to the DO. Because the name
   is deterministic, the desktop and phone **of the same account + room** reach the
   **same DO instance** = paired.

**2.2 `RelayRoom` Durable Object (`relay/src/relay-room.ts`)**
- Use the **WebSocket Hibernation API** (preferred for cost): create a `WebSocketPair`,
  call `this.ctx.acceptWebSocket(server, [role])` (tags by role), and return the
  client end with `status: 101`.
- Track sockets via `this.ctx.getWebSockets()`; persist tiny per-socket metadata with
  `serializeAttachment({ role, connectedAt })` so it survives hibernation (re-read in
  the constructor / via `deserializeAttachment()`).
- `async webSocketMessage(ws, msg)`: **blind relay** — forward `msg` verbatim to every
  *other* socket in the room (`getWebSockets().filter(s => s !== ws)`). Do **not**
  parse, do **not** log payloads. Optionally enforce a max frame size and a simple
  rate limit (anti-abuse) on the *envelope*, never the plaintext.
- `async webSocketClose(ws, code, reason)`: drop the socket; notify the peer with a
  relay-generated `presence offline` control frame (this is metadata, not user
  content, so it may be sent in clear or as a tiny known marker).
- `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` for
  keepalive without waking the DO.
- **Room policy:** allow exactly one `desktop` + N `mobile` sockets (N≥1). A second
  desktop with the same room id either replaces the old one or is rejected (decide in
  Phase 6; default: newest wins, old gets a `replaced` close code).

**2.3 `wrangler.jsonc`**
```jsonc
{
  "name": "trenlens-relay",
  "main": "src/index.ts",
  "compatibility_date": "2025-xx-xx",
  "durable_objects": { "bindings": [
    { "name": "RELAY_ROOM", "class_name": "RelayRoom" }
  ]},
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RelayRoom"] }  // SQLite-backed DO (free tier)
  ],
  "vars": {
    "SUPABASE_JWKS_URL": "https://<proj>.supabase.co/auth/v1/.well-known/jwks.json",
    "JWT_ISSUER": "https://<proj>.supabase.co/auth/v1",
    "JWT_AUDIENCE": "authenticated",
    "JWT_MODE": "jwks"
  }
  // HS256 local secret, if used, goes in a Secret (wrangler secret put), never vars.
}
```

**Packages (npm, in `relay/`):** `jose` (JWT verify), `wrangler` (dev/deploy, devDep),
`@cloudflare/workers-types` (devDep). No external runtime deps beyond `jose`.

**Logic flow recap:** `upgrade → verify JWT → roomName = sub:pairingId → idFromName →
DO.acceptWebSocket → relay opaque frames`.

**Deliverables:** deployable Worker + DO; `wrangler dev` local run; `wrangler deploy`
to a `*.workers.dev` (or custom) host; documented `wss://` URL for the clients.

**Acceptance criteria:**
- Connecting with no/expired/wrong-issuer JWT → rejected at handshake (`401`).
- Two raw WS clients (e.g. `websocat`/a test script) presenting **same-account** JWTs
  + same `room` exchange bytes; **different `sub`** never see each other's frames.
- The DO hibernates while idle and resumes on the next frame (verify in logs).
- The Worker logs contain **no plaintext payloads** (only metadata).

**Out of scope this phase:** real encryption (test with plaintext frames here), the
Rust client, the PWA. This phase ends with a verified blind pipe.

---

### Phase 3 — Security Layer (E2E encryption & QR pairing)

**Goal:** generate an ephemeral AES-256 key on the desktop, transfer it to the phone
by QR, and make every wire frame AES-GCM ciphertext — proving Rust↔WebCrypto interop.

**3.1 Key generation & lifecycle (desktop, Rust — `remote/session.rs`)**
- Generate a fresh **32-byte** key with `OsRng` (the same CSPRNG `crypto/mod.rs`
  uses) per pairing session. Hold it in `RemoteState` (Tauri managed state) for the
  process/session lifetime; **never persist it, never log it, never cross IPC as
  bytes** — only the base64url form leaves Rust, and only to render the QR.
- Generate a `pairingId` (ULID/UUID). Build the `trenlens://pair?...` URI (§3.3).
- TTL/arming: the room is "armed" only while pairing is active; rotate the key on
  re-pair. (A future hardening: bind the key to a short expiry + single mobile claim.)

**3.2 QR rendering (desktop frontend)**
- IPC `remote_start_pairing()` returns `{ pairingId, keyB64Url, uri }`.
- Render `uri` as a QR in the Remote panel with a JS QR lib (`qrcode` or
  `qrcode.react`). Keeping QR rendering in JS avoids adding a QR crate to Rust.

**3.3 Key import & crypto (mobile, Web Crypto — `mobile/lib/crypto.ts`)**
- After scanning, parse the URI, base64url-decode `k` → `ArrayBuffer`.
- `await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false,
  ["encrypt","decrypt"])`.
- Encrypt: random 12-byte IV via `crypto.getRandomValues`; `crypto.subtle.encrypt(
  { name:"AES-GCM", iv }, key, plaintextBytes)` → ciphertext **includes the 16-byte
  tag appended** (Web Crypto convention). Emit `{ iv: b64url(iv), ct: b64url(ct) }`.
- Decrypt: reverse. WebCrypto verifies the tag and throws on tamper — fail closed.

**3.4 Interop contract (the critical detail)**
- Rust `aes-gcm` (`Aes256Gcm`): `encrypt` returns ciphertext **with the tag appended**;
  the 96-bit nonce is supplied separately. Web Crypto `AES-GCM` does the same (tag
  appended to ciphertext, IV separate, `tagLength` defaults to 128 bits). Therefore:
  - **Rust → JS:** Rust sends `{ iv = nonce, ct = ciphertext||tag }`; JS calls
    `decrypt({name:"AES-GCM", iv}, key, ct)`. ✔ compatible.
  - **JS → Rust:** JS sends `{ iv, ct = ciphertext||tag }`; Rust calls
    `cipher.decrypt(Nonce::from_slice(iv), ct)`. ✔ compatible.
  - No AAD in v1 (set none on both sides). If we later bind frames to `id`/`type`,
    we add identical AAD on both ends.
- **Phase-3 conformance test (must pass before Phase 4/5 integrate):** a fixed key +
  fixed IV + fixed plaintext, encrypted in Rust, decrypts in a Node/WebCrypto harness
  to the same bytes, and vice-versa. This is the linchpin test of the whole feature.

**Packages (npm):** `qrcode` (or `qrcode.react`) for desktop; QR *scanning* lib is
Phase 5. Web Crypto is native — no package.
**Crates:** none new (reuses `aes-gcm`, `base64`, `OsRng`); a ULID/UUID helper if not
already present (`uuid` or reuse the existing id scheme).

**Deliverables:** Rust `session.rs` (keygen, envelope encode/decode, base64url);
`mobile/lib/crypto.ts`; the cross-language conformance test + fixtures.

**Acceptance criteria:**
- Round-trip vectors pass **both directions** (Rust↔WebCrypto), tag verification
  included.
- Tampered `ct` or wrong key → decryption error on both sides (fail closed, §5 rule).
- The key never appears in any log, IPC payload (as bytes), or persisted store.

**Out of scope this phase:** moving real chat through it (that's Phase 4/5); we test
the crypto in isolation with harnesses.

---

### Phase 4 — Desktop WebSocket Client (Rust)

**Goal:** a headless background WS client in the Tauri backend that authenticates to
the relay, joins the room, decrypts incoming commands, runs them through the existing
orchestrator, and encrypts results back — all without blocking the UI.

**4.1 Module & state (`remote/`)**
- `RemoteState` (Tauri-managed, like `ProxyState`/`HostState`): holds the current
  session (AES key, pairingId), a task handle + cancellation token, connection status,
  and the JWT (refreshed from the frontend). Mirrors the existing managed-state
  pattern wired in `lib.rs`.
- Spawn the client on `tauri::async_runtime` (same approach as the axum MCP host in
  `lib.rs` `setup()`), but **on demand** (when the user enables Remote Control), not at
  startup — an idle remote client is pointless and is an attack surface.

**4.2 Connection (`remote/client.rs`)**
- `tokio-tungstenite::connect_async(request)` where `request` is built with
  `http::Request::builder().uri(wss_url).header("Sec-WebSocket-Protocol", protocols)…
  .body(())` — `connect_async` accepts a `Request` precisely so we can set the
  subprotocol/headers (§3.1). Use the **rustls** feature
  (`tokio-tungstenite = { version = "0.x", features = ["connect","rustls-tls-webpki-roots"] }`)
  to stay on rustls/`ring`, consistent with the app's `reqwest` `rustls-tls` choice
  (no OpenSSL on Windows).
- Split the stream (`futures-util::StreamExt`/`SinkExt`); a read loop receives frames,
  a write half is fed by an `mpsc` channel so multiple producers (results, presence,
  pings) serialize cleanly.
- **Resilience:** reconnect with capped exponential backoff on drop; re-present a
  fresh JWT each reconnect; surface status to the UI via a Tauri event
  (`remote://status`) so the panel shows connected/paired/offline.

**4.3 Command handling — pipe into the orchestrator**
- On a decrypted `chat` message: resolve everything the existing
  `submit_chat_message` resolves — provider (default `anthropic`), sealed key via
  `lookup_secret(db, crypto, provider)` then unseal (§5), history via
  `db.list_messages(sessionId)` (last `HISTORY_TURNS`), then call
  `orchestrator::run_chat(router, provider, &key, model, &history, &text, &images)`.
- **Refactor for DRY:** extract the shared core of `commands::submit_chat_message`
  into a reusable `run_turn(app_handle, params) -> ChatResult` so *both* the IPC
  command and the remote handler call one code path. The remote handler reaches the
  managed states (`McpRouter`, `MemoryHandle`, `CryptoState`) through the `AppHandle`
  (`app.state::<…>()`), exactly as commands do.
- Persist the round-trip to the same `conversations`/`messages` store so the desktop
  UI and the phone share one timeline (a remote turn is indistinguishable from a local
  one in storage). Tag provenance if useful (e.g. a `source: remote` note), but the
  schema already supports it without change.
- Encrypt the `ChatResult` into a `chatResult` envelope and send it back.
- **Streaming (optional, recommended):** `run_chat` is non-streamed today (the agentic
  loop needs whole tool-call blocks), and the desktop UI fakes streaming with a
  word-chunk animation. For the phone we can either (a) send one `chatResult` and let
  the PWA do the same chunk animation (simplest, ship first), or (b) add `chunk`
  frames later. v1 = (a).

**4.4 New IPC commands (`commands.rs` + `lib.rs` handler list + `src/lib/remote.ts`)**

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `remote_start_pairing` | – | `{ pairingId, keyB64Url, uri }` | gen key + room, arm pairing |
| `remote_connect` | `{ jwt, relayUrl? }` | `RemoteStatus` | open the WS client, join room |
| `remote_update_token` | `{ jwt }` | `()` | push a refreshed Supabase token |
| `remote_disconnect` | – | `RemoteStatus` | stop client, drop key, disarm |
| `remote_status` | – | `RemoteStatus` | poll connection/pairing state |

(Plus a Tauri **event** `remote://status` for push updates to the panel.)

**Capabilities:** the WS client is a *Rust-side* outbound connection — it does **not**
need a new Tauri capability (capabilities gate the *frontend's* IPC/plugin access, and
these are named commands already authorized by being in the handler list). The CSP's
`connect-src` governs the *webview*, not Rust, so no CSP change is required for the
Rust socket. (The desktop frontend never opens the relay socket — only Rust does.)

**Crates (add to `src-tauri/Cargo.toml`):**
- `tokio-tungstenite` (features: `connect`, `rustls-tls-webpki-roots`)
- `futures-util` (stream/sink combinators)
- `http` (build the upgrade `Request`)
- (`tokio` already present with `full`; `aes-gcm`, `base64`, `serde_json` already present)

**Deliverables:** `remote/` module; refactored `run_turn`; new commands wired in
`lib.rs`; `src/lib/remote.ts` IPC wrappers; the desktop Remote panel
(`components/remote/`) showing login → QR → status.

**Acceptance criteria:**
- Enabling Remote Control connects to the relay, joins the room, and reports
  `connected`.
- A plaintext test command injected at the relay (or a stub mobile) round-trips
  through `run_chat` and returns an encrypted `chatResult`.
- Killing the network drops to `offline` and auto-reconnects with a fresh token.
- No plaintext key/JWT in logs; the orchestrator path is byte-identical to a local
  `submit_chat_message` turn.

---

### Phase 5 — Mobile Client (Next.js PWA)

**Goal:** a lightweight, installable, mobile-first web app: log in (same Supabase
account), scan the desktop QR, open the authenticated socket, decrypt, and drive the
chat from anywhere.

**5.1 App shell & PWA**
- New Next.js App-Router app in `mobile/`. Provide `app/manifest.webmanifest` (or
  `app/manifest.ts`), icons, theme color, `display: standalone`.
- Service worker for installability/offline shell. Serve the SW **from the origin
  root** (security requirement; a redirect-served SW is refused by browsers). Either
  hand-roll a minimal SW or use a maintained PWA plugin compatible with Next 15.
- Deploy to **Cloudflare Pages** (HTTPS, same ecosystem as the relay; secure context
  satisfies camera + SW requirements).

**5.2 Auth (`mobile/lib/supabase.ts`)**
- `@supabase/supabase-js` login screen (email/password). Persist session; on
  `onAuthStateChange`, keep the access token current. The token is what the socket
  presents in `auth.<jwt>`.

**5.3 QR scanning (`app/scan`)**
- Use a maintained scanner lib — e.g. `@yudiel/react-qr-scanner` or `html5-qrcode`
  (wrap Nimiq's `qr-scanner`/ZXing). Request camera via `getUserMedia` (needs HTTPS).
- Parse `trenlens://pair?room=…&k=…` → import the AES key (`mobile/lib/crypto.ts`,
  Phase 3) and remember `pairingId`.

**5.4 Transport (`mobile/lib/ws.ts`)**
- Open `new WebSocket(wssUrl, ["trenlens.relay.v1", "auth."+b64url(jwt),
  "room."+pairingId, "role.mobile"])`. The browser sends these as
  `Sec-WebSocket-Protocol`; the relay echoes `trenlens.relay.v1`.
- On open: optionally send a `historyRequest` so the timeline backfills.
- On message: decrypt `{iv,ct}` → dispatch by `type` → render.
- On send: build `RemoteMessage` → encrypt → frame → send.
- Reconnect/backoff; refresh JWT before reconnchoosing.

**5.5 UI**
- Chat timeline (reuse the visual language/markdown rendering ethos from the desktop;
  `react-markdown`+`remark-gfm` as the desktop uses). Composer with send. Connection +
  pairing status. Image attachment is optional for v1 (the envelope already supports
  `images`).

**Packages (npm, in `mobile/`):** `next`, `react`, `@supabase/supabase-js`, a QR
scanner (`@yudiel/react-qr-scanner` **or** `html5-qrcode`), `react-markdown`,
`remark-gfm`, a PWA/SW helper (optional). Web Crypto + `WebSocket` are native.

**Deliverables:** the `mobile/` app (login, scan, chat), deployed to Pages, installable
on iOS/Android, talking to the real relay + desktop.

**Acceptance criteria:**
- Same-account login + QR scan pairs to the desktop; a message sent from the phone
  produces a real orchestrator answer (with tools) rendered on the phone.
- The relay/Worker logs show only ciphertext; decryption happens only on the phone.
- A wrong-account phone (valid Supabase user, different `sub`) **cannot** pair.
- The app installs as a PWA and the camera scan works on a real device over HTTPS.

---

### Phase 6 — Integration, Hardening & Observability

**Goal:** make it safe, debuggable, and pleasant; flip it from "behind a toggle" to a
real feature.

- **Threat-model pass (see §5 below):** CSWSH/origin checks at the Worker, replay and
  rate limits on the envelope, frame-size caps, room-occupancy policy (one desktop),
  key TTL + explicit "stop sharing", JWT `exp`/refresh handling on long sockets,
  optional periodic re-handshake.
- **Provenance & control:** show on the desktop when a remote device is connected;
  allow the user to revoke (disconnect + rotate key) instantly. A remote turn should
  be visible/attributable in the desktop timeline.
- **Failure UX:** clear states for "relay unreachable", "not paired", "token expired",
  "no provider key" (`error` envelope with `code`).
- **Observability:** structured Worker logs (metadata only — never payloads); desktop
  `tracing` spans for connect/decrypt/run/encrypt; a hidden diagnostics view.
- **Tests:** the Phase-3 crypto conformance vectors in CI; a Worker integration test
  with two stub sockets; a desktop test that `run_turn` parity holds between IPC and
  remote paths.
- **Docs:** user-facing "Remote Control" setup; update `RESEARCH_AND_GUIDELINES.md`
  (new §) and `CHANGELOG.md`; deployment runbook for the relay + PWA.

**Acceptance criteria:** all earlier criteria hold under adversarial inputs; the
feature is documented; the relay deploy + PWA deploy are reproducible from the repo.

---

## 5. Threat model (explicit)

| Adversary / risk | Mitigation |
|---|---|
| Stranger connects to relay | JWT signature verified against Supabase JWKS at the edge; bad/expired → handshake `401`. |
| Cross-account pairing | DO room = `sub:pairingId`; different `sub` ⇒ different DO instance ⇒ never paired. |
| Curious/compromised relay reads chats | E2E AES-256-GCM; key never transits network (QR out-of-band); relay forwards opaque ciphertext only. |
| Tampered frames | AES-GCM auth tag verified on decrypt; fail closed (no partial output), per §5. |
| MITM on the wire | TLS (`wss://`) Cloudflare-side **plus** independent E2E layer; relay can't downgrade content. |
| Stolen JWT (token theft) | Short `exp` + refresh; E2E key still required to read/produce valid frames; revoke by rotating key / disconnect. |
| Leaked QR photo | Reveals key + room, but no relay host and no JWT; an attacker also needs a same-account login *and* the room still armed. Mitigate with key TTL + single-claim. |
| CSWSH (cross-site WS hijack) | Worker checks `Origin` for browser clients; tokens in subprotocol not cookies (no ambient auth). |
| Replay / flooding | Per-frame ULID + optional nonce/seen-cache; relay frame-size cap + rate limit on envelope metadata. |
| Idle attack surface | Remote client is opt-in, not auto-started; key + room are ephemeral and revocable. |

**Non-goals (v1):** forward secrecy / key ratcheting (single session key per pairing);
multi-desktop fan-out (one desktop per room); offline message queueing in the relay
(the DO relays live; history backfill comes from the desktop, not the relay).

---

## 6. Dependency manifest (single source of truth)

**Rust (`src-tauri/Cargo.toml`) — NEW:**
- `tokio-tungstenite` (features `connect`, `rustls-tls-webpki-roots`)
- `futures-util`
- `http`
- *(reuse: `tokio` full, `aes-gcm`, `base64`, `serde`/`serde_json`, `reqwest` rustls)*

**Relay (`relay/package.json`) — NEW project:**
- runtime: `jose`
- dev: `wrangler`, `@cloudflare/workers-types`, `typescript`

**Desktop frontend (`src/`) — NEW:**
- `@supabase/supabase-js`, `qrcode` (or `qrcode.react`)

**Mobile PWA (`mobile/package.json`) — NEW project:**
- `next`, `react`, `react-dom`, `@supabase/supabase-js`
- QR scan: `@yudiel/react-qr-scanner` **or** `html5-qrcode`
- render: `react-markdown`, `remark-gfm`
- optional PWA/SW helper
- *(native: Web Crypto `SubtleCrypto`, `WebSocket`, `getUserMedia`)*

**Tooling:** Supabase CLI, Docker Desktop, a Cloudflare account (Workers + Pages).

---

## 7. Open decisions to confirm before/while building

1. **Local Supabase JWT mode:** enable asymmetric signing keys locally (matches prod
   JWKS path) vs. accept the legacy HS256 secret with a Worker `JWT_MODE` switch.
   *Recommendation:* enable signing keys locally so dev == prod verification path.
2. **Streaming to the phone:** v1 sends one `chatResult` and the PWA fakes streaming
   (parity with desktop). Add `chunk` frames later? *Recommendation:* defer.
3. **Multiple mobiles / multiple desktops per room:** v1 = 1 desktop + N mobiles;
   second desktop "newest wins". Confirm.
4. **Key TTL & re-pair UX:** auto-rotate key on panel close vs. explicit "Stop
   sharing". *Recommendation:* both — rotate on close, expose explicit revoke.
5. **Relay host & custom domain:** `*.workers.dev` for dev; custom domain for prod.
6. **Mobile image attachments in v1:** envelope supports it; ship text-only first?

---

## 8. Sources (research backing this plan)

- Supabase — Introducing JWT Signing Keys: https://supabase.com/blog/jwt-signing-keys
- Supabase — JWTs / Signing Keys / JWKS: https://supabase.com/docs/guides/auth/jwts , https://supabase.com/docs/guides/auth/signing-keys
- Supabase — Local Development & CLI: https://supabase.com/docs/guides/local-development , https://supabase.com/docs/guides/local-development/cli/getting-started
- Cloudflare — Durable Objects WebSockets & Hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- Cloudflare — Workers WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/
- JWT over WebSocket via `Sec-WebSocket-Protocol`: https://websockets.readthedocs.io/en/stable/topics/authentication.html , https://github.com/jupyter/enhancement-proposals/issues/119
- `jose` — `createRemoteJWKSet` / `jwtVerify`: https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md
- Validating JWTs at the edge (Workers): https://securityboulevard.com/2025/11/how-to-validate-jwts-efficiently-at-the-edge-with-cloudflare-workers-and-vercel/
- `tokio-tungstenite` connect with a `Request` (custom headers/subprotocol): https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/ , https://github.com/snapview/tokio-tungstenite/issues/92
- Web Crypto AES-GCM: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt
- Next.js PWA: https://nextjs.org/docs/app/guides/progressive-web-apps

---

*End of plan. Awaiting instruction to begin **Phase 1 — Identity Layer (Supabase)**.*
