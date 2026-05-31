'use client';

/**
 * Web Crypto AES-256-GCM — the mobile half of the TrenLens E2E layer (Phase 3).
 *
 * Byte-for-byte compatible with the Rust side (src-tauri/src/remote/session.rs):
 * the key is raw 32 bytes (base64url), every frame is
 *   { iv: base64url(12-byte nonce), ct: base64url(ciphertext‖16-byte tag) }
 * and AES-GCM appends the tag to the ciphertext on both stacks. Proven against the
 * shared vector in scripts/aesgcm-conformance.mjs.
 *
 * The whole application message (including its `type`) is encrypted, so the relay
 * forwards an opaque `{iv, ct}` and learns nothing. The key is imported
 * non-extractable, so it can't be read back out of the CryptoKey.
 */

export interface RemoteEnvelope {
  iv: string;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Returns a fresh ArrayBuffer-backed view (Uint8Array<ArrayBuffer>) so the bytes
// satisfy WebCrypto's BufferSource — TS 5.7+ distinguishes that from ArrayBufferLike.
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(u8: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Import the 32-byte AES-256 key (base64url, from the scanned QR) — non-extractable. */
export async function importKey(keyB64Url: string): Promise<CryptoKey> {
  const raw = b64urlToBytes(keyB64Url);
  if (raw.length !== 32) throw new Error(`expected a 32-byte key, got ${raw.length}`);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Seal raw bytes into an envelope (fresh random 96-bit IV per call). */
export async function encryptEnvelope(key: CryptoKey, plaintext: Uint8Array): Promise<RemoteEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Copy into a fresh ArrayBuffer-backed view (see b64urlToBytes note).
  const data = new Uint8Array(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { iv: bytesToB64url(iv), ct: bytesToB64url(ct) };
}

/** Open an envelope back to raw bytes; the tag is verified (throws on tamper). */
export async function decryptEnvelope(key: CryptoKey, env: RemoteEnvelope): Promise<Uint8Array> {
  const iv = b64urlToBytes(env.iv);
  const ct = b64urlToBytes(env.ct);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/**
 * Seal a JSON application message into a wire frame (a serialized `{iv, ct}`).
 * This is what Phase 5's WebSocket transport sends for every outbound frame.
 */
export async function sealMessage(key: CryptoKey, message: unknown): Promise<string> {
  const env = await encryptEnvelope(key, enc.encode(JSON.stringify(message)));
  return JSON.stringify(env);
}

/** Open an inbound wire frame back into the application message. */
export async function openMessage<T = unknown>(key: CryptoKey, frame: string): Promise<T> {
  const env = JSON.parse(frame) as RemoteEnvelope;
  const pt = await decryptEnvelope(key, env);
  return JSON.parse(dec.decode(pt)) as T;
}
