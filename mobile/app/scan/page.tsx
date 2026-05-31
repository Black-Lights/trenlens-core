'use client';

/**
 * Pairing screen.
 *
 * Scan the desktop QR (or paste the `trenlens://pair` link), import the AES-256 key
 * with Web Crypto, run a self-test that seals + opens an `{iv, ct}` frame to prove the
 * key works, then arm the in-memory session and go to the chat. The key is held ONLY
 * in memory (never persisted), so a hard reload returns here to re-scan.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { QrScanner } from '@/components/QrScanner';
import { importKey, openMessage, sealMessage } from '@/lib/crypto';
import { parsePairUri } from '@/lib/pairing';
import { setRemoteSession } from '@/lib/session';

export default function ScanPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [cameraFailed, setCameraFailed] = useState(false);
  const [pairing, setPairing] = useState(false);
  const processing = useRef(false);

  async function handle(text: string) {
    if (processing.current) return;
    processing.current = true;
    setError(null);
    setPairing(true);
    try {
      const payload = parsePairUri(text);
      const key = await importKey(payload.keyB64Url);
      // Self-test: a real {iv, ct} round-trip proves the key before we commit to it.
      const sample = { v: 1, type: 'ping', t: Date.now() };
      const back = await openMessage<typeof sample>(key, await sealMessage(key, sample));
      if (back.t !== sample.t) throw new Error('Crypto self-test failed — the key did not round-trip.');

      setRemoteSession({ room: payload.room, key, keyB64Url: payload.keyB64Url });
      router.push('/chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      processing.current = false; // allow a retry
      setPairing(false);
    }
  }

  return (
    <main>
      <div className="card">
        <h1>Pair a desktop</h1>
        <p className="sub">Scan the QR shown in the desktop app&apos;s Remote Control panel.</p>

        {!cameraFailed && <QrScanner onResult={handle} onError={() => setCameraFailed(true)} />}

        <label htmlFor="manual">
          {cameraFailed ? 'Camera unavailable — paste the link' : 'Or paste the link'}
        </label>
        <input
          id="manual"
          placeholder="trenlens://pair?room=…&key=…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button onClick={() => void handle(manual)} disabled={pairing || !manual.trim()}>
          {pairing ? 'Pairing…' : 'Pair'}
        </button>
        {error && <p className="error">{error}</p>}

        <Link href="/">
          <button className="secondary">Back</button>
        </Link>
      </div>
    </main>
  );
}
