'use client';

/**
 * Camera QR scanner (Phase 3) — thin wrapper over `html5-qrcode`.
 *
 * `html5-qrcode` is loaded dynamically inside the effect so it never runs during
 * SSR (it touches `navigator`/`document`). Requires a secure context
 * (HTTPS/localhost) for `getUserMedia`. On any camera failure it reports through
 * `onError` so the page can fall back to manual paste.
 */

import { useEffect, useRef } from 'react';

import type { Html5Qrcode } from 'html5-qrcode';

const ELEMENT_ID = 'trenlens-qr-reader';

export function QrScanner({
  onResult,
  onError,
}: {
  onResult: (text: string) => void;
  onError?: (message: string) => void;
}) {
  // Hold the callbacks in refs so the camera isn't torn down on every re-render.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        const scanner = new Html5Qrcode(ELEMENT_ID);
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (decoded) => onResultRef.current(decoded),
          () => {
            /* per-frame "not found" errors are normal during scanning; ignore */
          },
        );
      } catch (e) {
        onErrorRef.current?.(e instanceof Error ? e.message : 'camera unavailable');
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop()
          .then(() => s.clear())
          .catch(() => {
            /* already stopped */
          });
      }
    };
  }, []);

  return <div id={ELEMENT_ID} className="qr-reader" />;
}
