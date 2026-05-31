'use client';

/**
 * Parse the desktop QR payload: `trenlens://pair?room=<pairingId>&key=<b64url key>&v=1`.
 * The `key` is the only secret; `room` scopes the relay's Durable Object
 * (`user_id:room`). The relay host is NOT in the QR — both apps read it from config
 * — so a leaked QR photo reveals only a key+room, useless without a same-account JWT.
 */

export interface PairingPayload {
  room: string;
  keyB64Url: string;
  version: number;
}

export function parsePairUri(input: string): PairingPayload {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error('Not a valid pairing link.');
  }
  if (u.protocol !== 'trenlens:') {
    throw new Error('Expected a trenlens:// pairing link.');
  }
  // `trenlens://pair?...` parses with host "pair"; tolerate `trenlens:pair?...` too.
  const target = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (target && target !== 'pair') {
    throw new Error('Unrecognized pairing link.');
  }
  const room = u.searchParams.get('room');
  const keyB64Url = u.searchParams.get('key');
  if (!room || !keyB64Url) {
    throw new Error('Pairing link is missing room or key.');
  }
  // A 32-byte key is 43 base64url chars (no padding).
  if (keyB64Url.length !== 43) {
    throw new Error('Pairing key looks malformed.');
  }
  return { room, keyB64Url, version: Number(u.searchParams.get('v') ?? '1') };
}
