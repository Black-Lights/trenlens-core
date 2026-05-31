'use client';

/**
 * Pairing screen.
 *
 * Two equal paths to pair, so a denied camera never dead-ends (esp. iOS):
 *   1. Tap "Scan QR code" → the camera starts ON A USER GESTURE (more reliable than
 *      auto-starting), decodes the `trenlens://pair` QR. Any denial/error drops to (2).
 *   2. Paste the `trenlens://pair` link (the desktop's "Copy link" button) — always
 *      visible, needs no camera permission at all.
 *
 * Either path runs the same `handle()`: parse → import the AES key → a real {iv, ct}
 * self-test to prove the key → arm the in-memory session → go to chat. The key lives
 * ONLY in memory (never persisted), so a hard reload returns here to re-pair.
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
  const [scanning, setScanning] = useState(false);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const processing = useRef(false);

  async function handle(text: string) {
    if (processing.current || !text.trim()) return;
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

  const startCamera = () => {
    setError(null);
    setCameraNote(null);
    setScanning(true);
  };

  // Camera denied / unavailable → stop, surface a friendly reason, keep the link path.
  const onCameraError = (message: string) => {
    setScanning(false);
    setCameraNote(message);
  };

  return (
    <main>
      <div className="card">
        <h1>Pair a desktop</h1>
        <p className="sub">Scan the QR in the desktop&apos;s Remote Control panel — or paste its link.</p>

        {scanning ? (
          <>
            <QrScanner onResult={handle} onError={onCameraError} />
            <button className="secondary" onClick={() => setScanning(false)}>
              Stop camera
            </button>
          </>
        ) : (
          <button onClick={startCamera} disabled={pairing}>
            Scan QR code
          </button>
        )}

        {cameraNote && <p className="note">{cameraNote}</p>}

        <div className="divider">or</div>

        <label htmlFor="manual">Paste the pairing link</label>
        <input
          id="manual"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="trenlens://pair?room=…&key=…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button onClick={() => void handle(manual)} disabled={pairing || !manual.trim()}>
          {pairing ? 'Pairing…' : 'Pair with link'}
        </button>

        {error && <p className="error">{error}</p>}

        <Link href="/">
          <button className="secondary">Back</button>
        </Link>
      </div>
    </main>
  );
}
