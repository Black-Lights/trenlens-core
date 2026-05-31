'use client';

/**
 * Remote Control — desktop config-panel section.
 *
 * The full desktop flow: sign in to Supabase (same account as the phone) → arm a
 * pairing (Rust mints an ephemeral AES-256 key + room id, rendered as the
 * `trenlens://pair` QR) → connect, which hands the Supabase JWT to the headless
 * Rust WebSocket client so it joins the blind relay and starts answering the phone.
 *
 * The key only ever appears inside the QR; it never leaves the devices and the relay
 * never sees the chat (E2E, §Phase 3). "Regenerate" rotates the key; "Disconnect"
 * stops the client AND drops the key (re-scan required — max-security default).
 *
 * Self-contained (no props) so it drops into the existing ServerSidebar.
 */

import { useEffect, useState } from 'react';

import { QRCodeSVG } from 'qrcode.react';
import type { Session } from '@supabase/supabase-js';

import { getAccessToken, getSession, onAccessToken, signInWithPassword, signOut } from '@/lib/auth';
import {
  connect as remoteConnect,
  disconnect as remoteDisconnect,
  isTauri,
  startPairing,
  status as remoteStatus,
  subscribeStatus,
  updateToken as remoteUpdateToken,
  type PairingInfo,
  type RemoteStatus,
} from '@/lib/remote';
import { isSupabaseConfigured } from '@/lib/supabase';

const OFFLINE: RemoteStatus = { state: 'offline', paired: false, roomId: null };

/** Human label + dot colour per connection state. */
function statusChrome(state: string): { label: string; color: string } {
  switch (state) {
    case 'connected':
      return { label: 'Connected', color: 'rgb(52 199 89)' };
    case 'connecting':
      return { label: 'Connecting…', color: 'rgb(255 179 64)' };
    case 'reconnecting':
      return { label: 'Reconnecting…', color: 'rgb(255 179 64)' };
    default:
      return { label: 'Offline', color: 'rgb(120 120 128)' };
  }
}

export function RemotePairing() {
  const tauri = isTauri();
  const [configured] = useState(isSupabaseConfigured());

  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [status, setStatus] = useState<RemoteStatus>(OFFLINE);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Load any persisted session on mount.
  useEffect(() => {
    if (!configured) return;
    getSession().then(setSession).catch(() => setSession(null));
  }, [configured]);

  // Live connection status: poll once, then follow pushed `remote://status` events.
  useEffect(() => {
    if (!tauri) return;
    remoteStatus().then(setStatus).catch(() => {});
    return subscribeStatus(setStatus);
  }, [tauri]);

  // Before the ~1h expiry, push refreshed tokens to the Rust client (ignored when
  // not connected). Mirrors `onAccessToken` → `remote_update_token` (§3.1 / 4.4).
  useEffect(() => {
    if (!session) return;
    return onAccessToken((token) => {
      if (token) remoteUpdateToken(token).catch(() => {});
    });
  }, [session]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => setSession(await signInWithPassword(email.trim(), password)));
  };
  const handleSignOut = () =>
    void run(async () => {
      await remoteDisconnect().catch(() => {});
      await signOut();
      setSession(null);
      setInfo(null);
    });

  const arm = () => void run(async () => setInfo(await startPairing()));

  const handleConnect = () =>
    void run(async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('No access token — sign in first.');
      setStatus(await remoteConnect(token));
    });
  const handleDisconnect = () => void run(async () => setStatus(await remoteDisconnect()));

  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard?.writeText(info.uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const chrome = statusChrome(status.state);
  const online = status.state !== 'offline';

  return (
    <section className="border-t border-hairline/60 px-4 py-4">
      <h3 className="mb-2 text-[13px] font-medium text-ink">Remote Control</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-ink-faint">
        Drive this desktop from your phone. Sign in, scan the one-time code with the TrenLens mobile
        app (same account), then connect. Chats are end-to-end encrypted — the relay never sees them.
      </p>

      {!tauri ? (
        <p className="text-[11px] text-pulse">Open the desktop app to use Remote Control.</p>
      ) : !configured ? (
        <p className="text-[11px] text-pulse">
          Not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
        </p>
      ) : !session ? (
        /* ── Sign in ─────────────────────────────────────────────────────────── */
        <form className="space-y-2" onSubmit={handleSignIn}>
          <input
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded-lg border border-hairline bg-surface-raised/40 px-2.5 py-2 text-[12px] text-ink outline-none focus:border-pulse/60"
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-lg border border-hairline bg-surface-raised/40 px-2.5 py-2 text-[12px] text-ink outline-none focus:border-pulse/60"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg py-2 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-30"
            style={{ background: 'rgb(var(--c-pulse))' }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : (
        /* ── Signed in: account + pairing + connection ───────────────────────── */
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-ink-muted">{session.user.email}</span>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={busy}
              className="shrink-0 text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-30"
            >
              Sign out
            </button>
          </div>

          {!info ? (
            <button
              type="button"
              onClick={arm}
              disabled={busy}
              className="w-full rounded-lg py-2 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-30"
              style={{ background: 'rgb(var(--c-pulse))' }}
            >
              {busy ? 'Generating…' : 'Generate pairing code'}
            </button>
          ) : (
            <>
              {/* QR needs a light quiet zone to scan reliably. */}
              <div className="mx-auto w-fit rounded-xl bg-white p-3">
                <QRCodeSVG value={info.uri} size={176} level="M" marginSize={2} />
              </div>

              <div className="rounded-lg border border-hairline/70 bg-surface-raised/40 px-2.5 py-2">
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                  Room
                </div>
                <code className="break-all font-mono text-[11px] text-ink-muted">{info.pairingId}</code>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={arm}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-hairline py-2 text-[12px] font-medium text-ink transition-colors hover:border-pulse/60 disabled:opacity-30"
                >
                  {busy ? 'Rotating…' : 'Regenerate'}
                </button>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="flex-1 rounded-lg border border-hairline py-2 text-[12px] font-medium text-ink transition-colors hover:border-pulse/60"
                >
                  {copied ? 'Copied ✓' : 'Copy link'}
                </button>
              </div>

              {/* Connection status + connect/disconnect */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-hairline/70 bg-surface-raised/40 px-2.5 py-2">
                <span className="flex items-center gap-2 text-[11px] text-ink-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: chrome.color }} />
                  {chrome.label}
                </span>
                {online ? (
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={busy}
                    className="text-[11px] font-medium text-pulse underline-offset-2 hover:underline disabled:opacity-30"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleConnect}
                    disabled={busy}
                    className="rounded-md px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity disabled:opacity-30"
                    style={{ background: 'rgb(var(--c-pulse))' }}
                  >
                    {busy ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </div>

              <p className="text-[11px] leading-relaxed text-ink-faint">
                Regenerating invalidates the previous QR. Disconnecting drops the key — re-scan to
                reconnect. The key never leaves your devices.
              </p>
            </>
          )}
        </div>
      )}

      {error && <p className="mt-2 break-words font-mono text-[10px] text-pulse">{error}</p>}
    </section>
  );
}
