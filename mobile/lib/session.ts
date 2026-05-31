'use client';

/**
 * Paired-session store — held IN MEMORY ONLY (a module singleton), never persisted.
 *
 * This is the security linchpin of the mobile flow: the AES `CryptoKey` is imported
 * non-extractable (Phase 3, crypto.ts) and lives only here for the lifetime of the
 * tab. It is never written to localStorage/sessionStorage/IndexedDB, so a stolen
 * device storage dump reveals nothing. The cost is that a hard reload loses the
 * pairing — `/chat` then redirects back to `/scan` to re-scan the QR.
 *
 * `sessionId` is minted once per pairing (NOT a secret): the phone sends it on every
 * `chat` so the desktop replays + persists history under it (multi-turn context).
 */

import { newId } from './protocol';

export interface RemoteSession {
  /** Pairing/room id from the QR (scopes the relay's Durable Object). */
  room: string;
  /** Non-extractable AES-256-GCM key (imported from the scanned QR). */
  key: CryptoKey;
  /** base64url of the key — for a short fingerprint display only. */
  keyB64Url: string;
  /** Phone-minted conversation id; stable for this pairing → multi-turn context. */
  sessionId: string;
}

let current: RemoteSession | null = null;

/** Arm the session after a successful pair (mints a fresh `sessionId`). */
export function setRemoteSession(s: Omit<RemoteSession, 'sessionId'> & { sessionId?: string }): RemoteSession {
  current = { ...s, sessionId: s.sessionId ?? `rmt_${newId()}` };
  return current;
}

export function getRemoteSession(): RemoteSession | null {
  return current;
}

export function clearRemoteSession(): void {
  current = null;
}
