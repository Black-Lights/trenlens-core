'use client';

/**
 * Registers the service worker (root-served `/sw.js`) once, after load, in a secure
 * context only (https or localhost) — the SW is for installability/offline shell.
 * Renders nothing.
 */

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return; // browsers refuse SWs off secure contexts
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);
  return null;
}
