# TrenLens Remote Control — Production Deployment Playbook

This is the strict, sequential runbook for taking **Remote Control** (phone-drives-desktop)
from `localhost` to the live internet: **Supabase Cloud** (identity) + **Cloudflare Workers**
(the blind relay) + **Cloudflare Pages** (the mobile PWA), with the **desktop** wired to the
same production relay.

Architecture recap: _Authenticated Blind Relay_ — Supabase mints ES256 JWTs; the Cloudflare
Worker verifies them against the project JWKS and pairs a desktop + phone in a per‑room Durable
Object; the chat itself is end‑to‑end AES‑256‑GCM encrypted, so the relay only ever forwards
opaque ciphertext.

---

## ⚠️ Two failure modes that are silent if skipped

1. **The cloud Supabase project MUST sign tokens with ES256 (asymmetric keys).**
   The relay verifies tokens via the project JWKS using `jose` + ES256
   ([relay/src/auth.ts](relay/src/auth.ts)). A default HS256 project exposes **no** public key
   in JWKS, so every connection returns `401`. You must rotate to ECC (P‑256) in the dashboard
   (Step 1). This mirrors the local `supabase/signing_keys.json` setup.

2. **`NEXT_PUBLIC_*` are inlined into the mobile bundle at BUILD time.**
   We upload the prebuilt `mobile/out` to Pages, so Cloudflare **never builds it** — setting env
   vars in the Pages dashboard does nothing. They must be present in `mobile/.env.local`
   **before** `npm run build`. Changing a value ⇒ rebuild + redeploy.

**Scope:** for "control my PC from anywhere," the phone **and** the desktop must (a) sign in to
the **same** production Supabase account (the relay room is keyed by `user_id`), and (b) dial the
**same** production relay (`wss://…/connect`).

---

## Config knobs (where each value is read)

| Surface | Variable | File | Notes |
|---|---|---|---|
| Relay | `SUPABASE_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | [relay/wrangler.jsonc](relay/wrangler.jsonc) `vars` | public, non‑secret |
| Mobile | `NEXT_PUBLIC_RELAY_URL` | `mobile/.env.local` | `wss://…/connect`, build‑time |
| Mobile | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `mobile/.env.local` | build‑time |
| Desktop | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | root `.env.local` | webview sign‑in |
| Desktop | `TRENLENS_RELAY_URL` | process env at launch | falls back to `ws://127.0.0.1:8787/connect` |

The Durable Object is already declared `new_sqlite_classes` in
[relay/wrangler.jsonc](relay/wrangler.jsonc) → **free‑tier eligible** (no paid Workers plan
required).

---

## Step 1 — Production Supabase (identity)

1.1  Create (or open) your cloud project at <https://supabase.com/dashboard>. Note the **Project
Ref** — the `xxxx` in `https://xxxx.supabase.co`. From it derive:

- Project URL → `https://<ref>.supabase.co`
- **JWKS** → `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`
- **Issuer (`iss`)** → `https://<ref>.supabase.co/auth/v1`
- **Audience (`aud`)** → `authenticated`
- **anon / publishable key** → Project Settings → API → `anon` public key (safe to ship in clients).

1.2  **Enable ES256.** Project Settings → **JWT Keys** → rotate/migrate the signing key to
**ECC (P‑256) = ES256** and make it the **current** key. Verify by opening the JWKS URL — you must
see a key with `"alg":"ES256"`.

1.3  Create the account you'll use on **both** devices (Authentication → Users → Add user, email +
password), since sign‑in is password‑based.

✅ **Gate:** the JWKS URL loads in a browser and shows an ES256 key.

---

## Step 2 — Cloudflare relay (deploy the Worker)

2.1  Point the relay at prod — set the three **top‑level `vars`** in
[relay/wrangler.jsonc](relay/wrangler.jsonc):

```jsonc
"vars": {
  "SUPABASE_JWKS_URL": "https://<ref>.supabase.co/auth/v1/.well-known/jwks.json",
  "JWT_ISSUER": "https://<ref>.supabase.co/auth/v1",
  "JWT_AUDIENCE": "authenticated"
}
```

> These are public values — fine to commit. Editing the top‑level `vars` is the simplest correct
> path. If you also want `wrangler dev` to keep using localhost, use an `env.production` block
> instead — but then repeat the `durable_objects` + `migrations` blocks inside it (bindings aren't
> inherited by named environments).

2.2  Log in and deploy:

```bash
cd relay
npm install
npx wrangler login        # opens a browser to authorize
npx wrangler deploy
```

2.3  Copy the deployed URL from the output: `https://trenlens-relay.<your-subdomain>.workers.dev`.
Your relay endpoint is that host **+ `/connect`, over wss**:

```
wss://trenlens-relay.<your-subdomain>.workers.dev/connect
```

2.4  (Recommended) Tail the logs while you test — the relay logs every upgrade decision (never the
JWT):

```bash
npx wrangler tail trenlens-relay
```

✅ **Gate:** `wrangler deploy` prints a `workers.dev` URL with no errors.

---

## Step 3 — Mobile PWA (env → build → deploy to Pages)

3.1  Set **all three** in `mobile/.env.local` (build‑time — must exist before the build):

```
NEXT_PUBLIC_RELAY_URL=wss://trenlens-relay.<your-subdomain>.workers.dev/connect
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your prod anon key>
```

3.2  Build the static export (produces `mobile/out`):

```bash
cd mobile
npm install
npm run build
```

3.3  Deploy the prebuilt folder to Cloudflare Pages (first run creates the project):

```bash
npx wrangler pages deploy out --project-name trenlens-mobile --branch production
```

3.4  Copy the live URL: `https://trenlens-mobile.pages.dev`. Open it on the phone (Pages serves
HTTPS, so camera/QR, the service worker, and `wss://` all work) and **Add to Home Screen** to
install the PWA.

✅ **Gate:** the Pages URL opens on the phone and the login screen loads (no "not configured"
banner).

> **Re‑deploy rule:** any change to a `NEXT_PUBLIC_*` value requires **`npm run build` then
> redeploy** — the old values are frozen in the previous `out`.

---

## Step 4 — Desktop (join the same prod relay + account)

4.1  Point the desktop's Supabase at prod — root `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your prod anon key>
```

Rebuild/relaunch the desktop so the webview picks them up.

4.2  Point the desktop at the prod relay (the default is localhost). Set `TRENLENS_RELAY_URL` in the
launching environment — PowerShell, dev:

```powershell
$env:TRENLENS_RELAY_URL = "wss://trenlens-relay.<your-subdomain>.workers.dev/connect"
npm run tauri:dev
```

(For a packaged build, set the same machine/user env var before launching the exe. A built‑in
setting for the relay URL is a planned polish.)

4.3  In the desktop **Remote Control** panel: sign in (the **same** prod account as the phone) →
**Generate pairing code** → **Connect**. The pill goes green.

✅ **Gate:** `wrangler tail` shows `[relay] 101 upgrade ok → room …:… role=desktop`.

---

## Step 5 — End‑to‑end test "from anywhere"

5.1  Put the phone on **cellular** (not home Wi‑Fi) to prove it traverses the internet.
5.2  Open `https://trenlens-mobile.pages.dev` → sign in (same account) → **scan the QR** on the
desktop → you land on `/chat`.
5.3  Type on the phone → it appears + answers on the desktop; type on the desktop → it mirrors to
the phone. `wrangler tail` shows two `101 upgrade ok` lines (`role=desktop` and `role=mobile`).

---

## Troubleshooting (symptom → cause)

| Symptom | Likely cause |
|---|---|
| Relay logs `[relay:auth] JWT verification failed` / `401` | Cloud project isn't ES256 (Step 1.2), or issuer/JWKS in `wrangler.jsonc` don't match the Project Ref |
| Desktop stuck **Reconnecting** | `TRENLENS_RELAY_URL` unset/wrong, missing `/connect`, or `ws://` instead of `wss://` |
| Phone can't sign in | `mobile/.env.local` still points at localhost Supabase (rebuild after fixing) |
| Both "connected" but never see each other | Different Supabase accounts → different rooms (room = `user_id:pairingId`) |
| Phone connects then blank / mixed‑content error | PWA is HTTPS but `NEXT_PUBLIC_RELAY_URL` is `ws://` — must be `wss://` |

## Security notes

- The relay only needs the **public JWKS** — it is verify‑only and holds no secret. **Never** put
  the Supabase `service_role` key anywhere near it.
- The **anon** key is public by design; safe in the mobile/desktop bundles.
- Keep `supabase/signing_keys.json` and both `.env.local` files **gitignored** (already are).
- A manual **Disconnect** on the desktop drops the E2E key — re‑pair (re‑scan the QR) to reconnect.
