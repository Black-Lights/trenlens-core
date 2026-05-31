'use client';

/**
 * Auth helpers for the mobile PWA (Phase 1) — mirror of the desktop's
 * `src/lib/auth.ts` so both ends share one mental model. Verification of tokens
 * is NOT done here; the relay verifies signatures against the Supabase JWKS.
 */

import type { Session } from '@supabase/supabase-js';

import { getSupabase } from './supabase';

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('sign-in returned no session');
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.access_token ?? null;
}

export function onAccessToken(cb: (token: string | null) => void): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    cb(session?.access_token ?? null);
  });
  return () => data.subscription.unsubscribe();
}

export interface JwtClaims {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  [k: string]: unknown;
}

/** Decode (NOT verify) a JWT payload for display — trust lives at the relay. */
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
