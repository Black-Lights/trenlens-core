'use client';

/**
 * Remote Control client surface (desktop webview).
 *
 * Phase 3 exposed pairing (mint an ephemeral E2E key + room id → the `trenlens://pair`
 * QR). Phase 4 adds the live connection: hand the Rust client the Supabase JWT to
 * open the relay socket, push refreshed tokens, disconnect (which drops the key), and
 * subscribe to pushed status. Everything routes through the one IPC bridge (`ipc`),
 * so this stays a thin, typed facade.
 */

import { ipc, isTauri, type PairingInfo, type RemoteStatus } from './ipc';

export type { PairingInfo, RemoteStatus };
export { isTauri };

/** Arm a fresh pairing (rotates any previous key) → the QR payload to display. */
export const startPairing = (): Promise<PairingInfo> => ipc.remoteStartPairing();

/** Open the relay socket for the armed pairing (desktop side). */
export const connect = (jwt: string, relayUrl?: string): Promise<RemoteStatus> =>
  ipc.remoteConnect(jwt, relayUrl);

/** Push a refreshed Supabase token (applied on the next reconnect). */
export const updateToken = (jwt: string): Promise<void> => ipc.remoteUpdateToken(jwt);

/** Stop the client and drop the E2E key (re-pair required to reconnect). */
export const disconnect = (): Promise<RemoteStatus> => ipc.remoteDisconnect();

/** Poll the current connection/pairing state. */
export const status = (): Promise<RemoteStatus> => ipc.remoteStatus();

/** Event name the Rust client emits on every status transition (mirrors `remote::STATUS_EVENT`). */
const STATUS_EVENT = 'remote://status';

/**
 * Subscribe to live status pushes from the Rust client. Returns an unsubscribe fn
 * (a no-op outside Tauri). Uses the global Tauri event API (`withGlobalTauri`) so we
 * don't import `@tauri-apps/api/event` into the browser-preview bundle.
 */
export function subscribeStatus(cb: (s: RemoteStatus) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = (window as any).__TAURI__?.event;
  if (!ev?.listen) return () => {};

  let unlisten: (() => void) | null = null;
  let cancelled = false;
  ev.listen(STATUS_EVENT, (e: { payload: RemoteStatus }) => cb(e.payload)).then(
    (un: () => void) => {
      if (cancelled) un();
      else unlisten = un;
    },
  );
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
