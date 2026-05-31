#!/usr/bin/env node
/**
 * AES-256-GCM cross-language conformance vector for TrenLens Remote Control (Phase 3).
 *
 * Computes the Web Crypto (SubtleCrypto) output for a FIXED (key, iv, plaintext) so
 * the Rust side (src-tauri/src/remote/session.rs) can assert it produces byte-identical
 * ciphertext+tag. Because AES-GCM is deterministic given key+iv+plaintext (no AAD),
 * matching ciphertext proves BOTH directions interop (Rust→JS and JS→Rust):
 * whatever one stack encrypts, the other decrypts.
 *
 * The envelope on the wire is { iv: base64url(nonce), ct: base64url(ciphertext‖tag) }.
 * Run: node scripts/aesgcm-conformance.mjs
 */

const key = Uint8Array.from({ length: 32 }, (_, i) => i); // 00..1f
const iv = Uint8Array.from({ length: 12 }, (_, i) => i); //  00..0b
const plaintext = new TextEncoder().encode('{"v":1,"type":"chat","text":"hi"}');

const b64url = (u8) => Buffer.from(u8).toString('base64url');

const k = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plaintext));
const back = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct));

console.log('key (b64url):', b64url(key));
console.log('iv  (b64url):', b64url(iv));
console.log('pt         :', new TextDecoder().decode(plaintext));
console.log('ct  (b64url):', b64url(ct));
console.log('roundtrip  :', new TextDecoder().decode(back));
console.log('tag bytes  :', ct.length - plaintext.length, '(expect 16)');
