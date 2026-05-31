'use client';

/**
 * Supabase client for the TrenLens Remote Control mobile PWA (Phase 1).
 *
 * The phone must be signed into the SAME Supabase account as the desktop — the
 * relay pairs the two connections by matching the JWT `sub` claim
 * (REMOTE_ARCHITECTURE_PLAN.md §3.1 / Phase 2). This client owns that login and
 * the resulting access token, which Phase 5 will present to the relay in the
 * `Sec-WebSocket-Protocol` handshake.
 *
 * Config is read from NEXT_PUBLIC_* env (see `.env.local`). Point this at the
 * SAME Supabase project as the desktop (`src/lib/supabase.ts`).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = (): boolean => Boolean(url && anonKey);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      '[supabase] not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in mobile/.env.local',
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
