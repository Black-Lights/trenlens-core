'use client';

/**
 * Phase 3 pairing screen.
 *
 * Scan the desktop QR (or paste the `trenlens://pair` link), import the AES-256
 * key with Web Crypto, and run a self-test that seals + opens an `{iv, ct}` frame
 * to prove the key works end-to-end. Phase 5 takes this paired key and opens the
 * live relay WebSocket; here we stop at "paired + crypto verified".
 */

import Link from 'next/link';
import { useRef, useState } from 'react';

import { QrScanner } from '@/components/QrScanner';
import { importKey, openMessage, sealMessage } from '@/lib/crypto';
import { parsePairUri, type PairingPayload } from '@/lib/pairing';

interface Paired {
  payload: PairingPayload;
  fingerprint: string;
  selfTest: 'ok' | 'mismatch';
}

export default function ScanPage() {
  const [paired, setPaired] = useState<Paired | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [cameraFailed, setCameraFailed] = useState(false);
  const processing = useRef(false);

  async function handle(text: string) {
    if (processing.current || paired) return;
    processing.current = true;
    setError(null);
    try {
      const payload = parsePairUri(text);
      const key = await importKey(payload.keyB64Url);
      // Self-test: a round-trip through the real {iv, ct} codec proves the key.
      const sample = { v: 1, type: 'ping', t: Date.now() };
      const frame = await sealMessage(key, sample);
      const back = await openMessage<typeof sample>(key, frame);
      setPaired({
        payload,
        fingerprint: payload.keyB64Url.slice(0, 8),
        selfTest: back.t === sample.t ? 'ok' : 'mismatch',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      processing.current = false; // allow a retry
    }
  }

  if (paired) {
    return (
      <main>
        <div className="card">
          <h1>Paired ✓</h1>
          <p className="sub">End-to-end key established with your desktop.</p>
          <div className="claims">
            <div>
              <b>room:</b> {paired.payload.room}
            </div>
            <div>
              <b>key:</b> {paired.fingerprint}… (32 bytes, in-memory only)
            </div>
            <div style={{ marginTop: 8 }}>
              <b>crypto self-test:</b>{' '}
              {paired.selfTest === 'ok' ? '✓ {iv,ct} round-trip OK' : '✗ mismatch'}
            </div>
          </div>
          <p className="sub" style={{ marginTop: 14 }}>
            Next (Phase 5): open the encrypted relay connection and start chatting.
          </p>
          <Link href="/">
            <button className="secondary">Back</button>
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="card">
        <h1>Pair a desktop</h1>
        <p className="sub">Scan the QR shown in the desktop app&apos;s Remote Control panel.</p>

        {!cameraFailed && <QrScanner onResult={handle} onError={() => setCameraFailed(true)} />}

        <label htmlFor="manual">{cameraFailed ? 'Camera unavailable — paste the link' : 'Or paste the link'}</label>
        <input
          id="manual"
          placeholder="trenlens://pair?room=…&key=…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button onClick={() => void handle(manual)} disabled={!manual.trim()}>
          Pair
        </button>
        {error && <p className="error">{error}</p>}

        <Link href="/">
          <button className="secondary">Back</button>
        </Link>
      </div>
    </main>
  );
}
