'use client';

/**
 * Camera QR scanner (Phase 3) — thin wrapper over `html5-qrcode`.
 *
 * `html5-qrcode` is loaded dynamically inside the effect so it never runs during
 * SSR (it touches `navigator`/`document`). Requires a secure context
 * (HTTPS/localhost) for `getUserMedia`. We pre-check the secure context + camera
 * API and classify `getUserMedia` rejections (denied / none / unsupported) into a
 * human message, reported through `onError` so the page can fall back to the paste
 * link cleanly instead of leaving a broken camera box (esp. on iOS, where a denied
 * permission must not dead-end the only way to pair).
 */

import { useEffect, useRef } from 'react';

import type { Html5Qrcode } from 'html5-qrcode';

const ELEMENT_ID = 'trenlens-qr-reader';

/** Turn a getUserMedia/scanner failure into a friendly, actionable message. */
function friendlyCameraError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera in your browser settings, or pair with the link below.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera was found. Pair with the link below instead.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it, or pair with the link below.';
    case 'NotSupportedError':
      return 'The camera needs a secure (https) page. Pair with the link below instead.';
    default:
      return 'Camera unavailable. Pair with the link below instead.';
  }
}

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
        // Pre-flight: catch the common dead-ends (insecure context / no camera API)
        // before html5-qrcode, which can otherwise render a broken box instead of
        // rejecting — leaving the user with no way forward.
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new DOMException('camera needs a secure context', 'NotSupportedError');
        }
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
        onErrorRef.current?.(friendlyCameraError(e));
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
