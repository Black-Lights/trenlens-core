'use client';

/**
 * Remote Control pairing — desktop config-panel section (Phase 3).
 *
 * Calls `remote_start_pairing` (Rust mints an ephemeral AES-256 key + room id),
 * then renders the `trenlens://pair?room=…&key=…` URI as a QR for the phone to
 * scan. The key only ever appears inside the QR; it never leaves the devices, and
 * the relay never sees the chat (E2E, §Phase 3). "Regenerate" rotates the key,
 * invalidating any previously shown QR.
 *
 * Self-contained (no props) so it drops into the existing ServerSidebar without
 * threading state through `useMcp`.
 */

import { useState } from 'react';

import { QRCodeSVG } from 'qrcode.react';

import { isTauri, startPairing, type PairingInfo } from '@/lib/remote';

export function RemotePairing() {
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tauri = isTauri();

  const arm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await startPairing());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <section className="border-t border-hairline/60 px-4 py-4">
      <h3 className="mb-2 text-[13px] font-medium text-ink">Remote Control</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-ink-faint">
        Drive this desktop from your phone. Scan the one-time code with the TrenLens mobile app
        (signed into the same account). Chats are end-to-end encrypted — the relay never sees them.
      </p>

      {!tauri ? (
        <p className="text-[11px] text-pulse">Open the desktop app to generate a pairing code.</p>
      ) : !info ? (
        <button
          type="button"
          onClick={() => void arm()}
          disabled={busy}
          className="w-full rounded-lg py-2 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-30"
          style={{ background: 'rgb(var(--c-pulse))' }}
        >
          {busy ? 'Generating…' : 'Enable Remote Control'}
        </button>
      ) : (
        <div className="space-y-3">
          {/* QR needs a light quiet zone to scan reliably. */}
          <div className="mx-auto w-fit rounded-xl bg-white p-3">
            <QRCodeSVG value={info.uri} size={176} level="M" marginSize={2} />
          </div>

          <div className="rounded-lg border border-hairline/70 bg-surface-raised/40 px-2.5 py-2">
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">Room</div>
            <code className="break-all font-mono text-[11px] text-ink-muted">{info.pairingId}</code>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void arm()}
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

          <p className="text-[11px] leading-relaxed text-ink-faint">
            Regenerating invalidates the previous QR. The key never leaves your devices.
          </p>
        </div>
      )}

      {error && <p className="mt-2 break-words font-mono text-[10px] text-pulse">{error}</p>}
    </section>
  );
}
