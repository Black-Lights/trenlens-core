'use client';

/**
 * Remote Control client surface (desktop webview).
 *
 * Phase 3 exposes pairing: mint an ephemeral E2E key + room id in the Rust backend
 * and get back the `trenlens://pair` QR payload. The live WebSocket connect/
 * disconnect/token helpers land here in Phase 4. Everything routes through the one
 * IPC bridge (`ipc`), so this stays a thin, typed facade.
 */

import { ipc, isTauri, type PairingInfo } from './ipc';

export type { PairingInfo };
export { isTauri };

/** Arm a fresh pairing (rotates any previous key) → the QR payload to display. */
export const startPairing = (): Promise<PairingInfo> => ipc.remoteStartPairing();
