'use client';

/**
 * Phase 1 mobile login screen.
 *
 * Proves the PWA authenticates against the SAME Supabase project as the desktop:
 * sign in with email + password, then show the resulting `sub` (the id the relay
 * pairs on) and a truncated access token. Phase 5 replaces this with the full
 * flow: QR scan → import the E2E key → open the relay WebSocket → chat timeline.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { Session } from '@supabase/supabase-js';

import {
  decodeJwtClaims,
  getSession,
  signInWithPassword,
  signOut,
  type JwtClaims,
} from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase';

export default function Home() {
  const [configured, setConfigured] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfigured(isSupabaseConfigured());
    if (isSupabaseConfigured()) {
      getSession().then(setSession).catch(() => setSession(null));
    }
  }, []);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await signInWithPassword(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
      setSession(null);
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <main>
        <div className="card">
          <h1>TrenLens Remote</h1>
          <p className="sub">Not configured</p>
          <p className="claims">
            Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in mobile/.env.local,
            then restart the dev server.
          </p>
        </div>
      </main>
    );
  }

  if (session) {
    const claims: JwtClaims | null = decodeJwtClaims(session.access_token);
    const token = session.access_token;
    return (
      <main>
        <div className="card">
          <h1>Signed in</h1>
          <p className="sub">{session.user.email}</p>
          <div className="claims">
            <div>
              <b>sub:</b> {claims?.sub ?? '(unknown)'}
            </div>
            <div>
              <b>iss:</b> {claims?.iss ?? '(unknown)'}
            </div>
            <div>
              <b>aud:</b> {String(claims?.aud ?? '(unknown)')}
            </div>
            <div style={{ marginTop: 8 }}>
              <b>token:</b> {token.slice(0, 24)}…{token.slice(-12)}
            </div>
          </div>
          <Link href="/scan">
            <button>Pair a desktop →</button>
          </Link>
          <button className="secondary" onClick={handleSignOut} disabled={busy}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <form className="card" onSubmit={handleSignIn}>
        <h1>TrenLens Remote</h1>
        <p className="sub">Sign in with the same account as your desktop.</p>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
