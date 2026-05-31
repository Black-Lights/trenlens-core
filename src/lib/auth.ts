'use client';

/**
 * Thin auth helpers over the Supabase client for Remote Control (Phase 1).
 *
 * These are the only auth primitives the rest of the desktop app needs:
 *   - sign in / out with email + password,
 *   - read the current access token (the JWT the relay authenticates — §3.1),
 *   - subscribe to token changes so the Rust client can be handed a fresh token
 *     before the ~1h expiry (wired in Phase 4 via `remote_update_token`),
 *   - decode (NOT verify) a JWT's claims for display/debugging — verification is
 *     the relay's job (Phase 2, jose + JWKS).
 */

import type { Session } from '@supabase/supabase-js';

import { getSupabase } from './supabase';

/** Sign in with email + password; returns the established session. */
export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('sign-in returned no session');
  return data.session;
}

/** Sign out and clear the persisted session. */
export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

/** The current session, or null when signed out. */
export async function getSession(): Promise<Session | null> {
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session;
}

/** The current access token (the relay bearer), or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.access_token ?? null;
}

/**
 * Subscribe to access-token changes (sign-in, sign-out, silent refresh). The
 * callback fires with the latest token (or null). Returns an unsubscribe fn.
 * Phase 4 uses this to push refreshed tokens into the Rust WebSocket client.
 */
export function onAccessToken(cb: (token: string | null) => void): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    cb(session?.access_token ?? null);
  });
  return () => data.subscription.unsubscribe();
}

/** A decoded JWT payload (the subset of claims we surface). */
export interface JwtClaims {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  [k: string]: unknown;
}

/**
 * Decode a JWT's payload WITHOUT verifying its signature — for showing the user
 * which account/`sub` is connected, never for trust decisions. The relay is the
 * sole authority that verifies signatures (against the Supabase JWKS).
 */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}
