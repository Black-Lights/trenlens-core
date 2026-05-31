'use client';

/**
 * Supabase client — the identity layer for TrenLens Remote Control (Phase 1).
 *
 * Remote Control pairs a desktop and a phone ONLY when both are signed into the
 * same Supabase account (the relay pairs by the JWT `sub` claim — see
 * REMOTE_ARCHITECTURE_PLAN.md §3.1 / Phase 2). This module owns the singleton
 * `@supabase/supabase-js` client used by the desktop webview to log in and obtain
 * that access token; the token is later handed to the Rust WebSocket client over
 * IPC (Phase 4) — it is NOT used to talk to the relay from the webview directly.
 *
 * Config comes from NEXT_PUBLIC_* env (inlined at build time for the static Tauri
 * export, read from `.env.local` during `next dev`). When unset, the app still
 * runs — `isSupabaseConfigured()` is false and the Remote panel stays disabled —
 * so the core app never hard-depends on Supabase being present.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when both the URL and anon key are present (gates the Remote UI). */
export const isSupabaseConfigured = (): boolean => Boolean(url && anonKey);

let client: SupabaseClient | null = null;

/**
 * The lazily-created singleton client. Sessions persist in the webview's
 * localStorage and auto-refresh (~hourly), so a desktop stays signed in across
 * restarts. `detectSessionInUrl` is off: the desktop uses email/password, not an
 * OAuth redirect, and the Tauri webview has no meaningful URL to parse.
 *
 * The `storageKey` is namespaced so Remote-Control auth never collides with any
 * other Supabase usage the app might add later.
 */
export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      '[supabase] not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY',
    );
  }
  if (!client) {
    client = createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'trenlens-remote-auth',
      },
    });
  }
  return client;
}
