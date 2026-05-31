#!/usr/bin/env node
/**
 * Phase 1 acceptance check for TrenLens Remote Control.
 *
 * Proves the identity layer end-to-end, exercising the EXACT verification path
 * the Cloudflare relay will use in Phase 2:
 *   1. Sign in (or sign up) a test user on the local Supabase Auth server.
 *   2. Open a SECOND client and sign in again — simulating the desktop + phone.
 *   3. Assert both tokens carry the SAME `sub` (the id the relay pairs on).
 *   4. Verify a token's signature with `jose` against the project's JWKS
 *      (/auth/v1/.well-known/jwks.json) — the asymmetric (ES256) path, no shared
 *      secret. This is byte-for-byte what the relay does at the edge.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL="http://127.0.0.1:54321"; $env:SUPABASE_ANON_KEY="<anon>"; node scripts/verify-supabase-jwt.mjs
 *
 * Exits non-zero on any failure so it can gate CI later.
 */

import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const TEST_EMAIL = process.env.TEST_EMAIL || 'remote-test@trenlens.local';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'test-password-123';

const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

if (!ANON_KEY) fail('Set SUPABASE_ANON_KEY (the local anon key from `supabase start`).');

/** Sign in; if the user doesn't exist yet, create it (local confirmations are off). */
async function getToken(label) {
  const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  let { data, error } = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
  if (error) {
    const signUp = await sb.auth.signUp({ email: TEST_EMAIL, password: TEST_PASSWORD });
    if (signUp.error) fail(`[${label}] auth failed: ${signUp.error.message}`);
    data = signUp.data;
  }
  if (!data.session) fail(`[${label}] no session returned (email confirmation may be required)`);
  return data.session.access_token;
}

console.log(`• Supabase URL : ${SUPABASE_URL}`);
console.log(`• JWKS URL     : ${JWKS_URL}`);
console.log(`• Test user    : ${TEST_EMAIL}\n`);

// (1)+(2) two independent clients, same credentials = desktop + phone.
const tokenA = await getToken('client-A/desktop');
const tokenB = await getToken('client-B/mobile');

// (3) same account ⇒ same sub.
const subA = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url')).sub;
const subB = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64url')).sub;
console.log(`client-A sub : ${subA}`);
console.log(`client-B sub : ${subB}`);
if (!subA || subA !== subB) fail('sub mismatch — the two clients are NOT the same identity.');
console.log('✓ both clients share the same sub (the relay would pair them)\n');

// (4) verify the signature against the JWKS — the relay's exact logic.
const header = decodeProtectedHeader(tokenA);
console.log(`JWT alg      : ${header.alg}   (kid: ${header.kid})`);
if (!header.alg || !header.alg.startsWith('ES')) {
  fail(`expected an asymmetric ES* algorithm, got "${header.alg}" — signing keys not active?`);
}

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));
let payload;
try {
  ({ payload } = await jwtVerify(tokenA, JWKS, { audience: 'authenticated' }));
} catch (e) {
  fail(`jose jwtVerify failed against JWKS: ${e.message}`);
}

console.log(`✓ signature verified against JWKS (no shared secret)`);
console.log(`  iss: ${payload.iss}`);
console.log(`  aud: ${JSON.stringify(payload.aud)}`);
console.log(`  exp: ${new Date(payload.exp * 1000).toISOString()}`);
console.log('\n✅ Phase 1 identity layer verified: asymmetric JWKS path + stable sub.');
