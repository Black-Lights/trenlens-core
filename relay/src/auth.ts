/**
 * Edge JWT verification — the relay's only job before pairing.
 *
 * Verifies a Supabase access token against the project's JWKS using `jose`, which
 * runs natively on the Workers WebCrypto runtime. `createRemoteJWKSet` fetches and
 * caches the public keys (in-isolate memory + Supabase edge cache ~10 min), so the
 * common path costs no network round-trip and never calls back to Supabase per
 * request. Asymmetric (ES256) keys mean the relay holds NO secret — it can verify
 * but never mint tokens. This is byte-for-byte the path proven in Phase 1
 * (scripts/verify-supabase-jwt.mjs).
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { Env } from './types';

// Cache the JWKS resolver across requests in the same isolate (keyed by URL so a
// var change rebuilds it). `createRemoteJWKSet` does its own key caching/rotation.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

function resolver(url: string) {
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrl = url;
  }
  return jwks;
}

/** A verified token is guaranteed to carry a non-empty `sub` (the pairing key). */
export type VerifiedClaims = JWTPayload & { sub: string };

/**
 * Verify signature + `iss`/`aud`/`exp`. Throws on any failure (caller maps to 401).
 * The `sub` claim is the Supabase user_id the relay pairs connections on.
 */
export async function verifyToken(token: string, env: Env): Promise<VerifiedClaims> {
  try {
    const { payload } = await jwtVerify(token, resolver(env.SUPABASE_JWKS_URL), {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (!payload.sub) throw new Error('token has no sub claim');
    return payload as VerifiedClaims;
  } catch (e) {
    // Surface the SPECIFIC reason for diagnostics (jose sets `.code`, e.g.
    // ERR_JWT_EXPIRED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED,
    // ERR_JWT_CLAIM_VALIDATION_FAILED for a bad iss/aud). Logged, never returned.
    const code = (e as { code?: string }).code ?? 'ERR_UNKNOWN';
    console.error(`[relay:auth] JWT verification failed: ${code} — ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
