//! Remote Control session crypto (Phase 3) — ephemeral E2E key + `{iv, ct}` envelope.
//!
//! Reuses the app's AES-256-GCM primitive (the same `aes-gcm` crate as crypto/ §5),
//! but in a **Web Crypto-compatible envelope**: the 96-bit nonce (`iv`) travels
//! SEPARATELY from the ciphertext, unlike §5's bundled `nonce‖ciphertext` blob —
//! because the browser's `SubtleCrypto.decrypt({name:"AES-GCM", iv}, …)` takes the
//! IV as its own argument. Both ends base64url-encode `iv` and `ct`, and AES-GCM
//! appends the 16-byte tag to the ciphertext on both stacks, so interop is exact
//! (proven byte-for-byte by `matches_webcrypto_vector` against
//! scripts/aesgcm-conformance.mjs).
//!
//! The key is generated here with the OS CSPRNG, lives only in this process, and
//! leaves Rust ONLY as the base64url string the desktop renders into the QR (§3.3).
//! It is never persisted, never logged, and never crosses IPC as raw bytes.

#![allow(dead_code)]

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
/// Length of the random pairing id (non-secret; the key is the secret). 16 bytes →
/// 22 base64url chars, plenty to scope a DO room (`user_id:pairingId`).
const PAIRING_ID_LEN: usize = 16;

/// One Web Crypto-compatible AES-GCM frame: `iv` = base64url(96-bit nonce),
/// `ct` = base64url(ciphertext‖16-byte tag). This is the ONLY thing the relay sees.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RemoteEnvelope {
    pub iv: String,
    pub ct: String,
}

/// An armed pairing: the ephemeral AES-256 key plus the room id shown in the QR.
pub struct PairingSession {
    pub pairing_id: String,
    key: [u8; KEY_LEN],
}

impl PairingSession {
    /// Mint a fresh random key + pairing id (the two halves of the QR payload).
    pub fn new() -> Self {
        let mut key = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut key);
        let mut id = [0u8; PAIRING_ID_LEN];
        OsRng.fill_bytes(&mut id);
        Self {
            pairing_id: URL_SAFE_NO_PAD.encode(id),
            key,
        }
    }

    /// base64url of the raw key — leaves Rust ONLY to be drawn into the QR (§3.3).
    pub fn key_b64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key)
    }

    /// The QR payload URI: `trenlens://pair?room=<pairingId>&key=<b64url key>&v=1`.
    pub fn pair_uri(&self) -> String {
        format!(
            "trenlens://pair?room={}&key={}&v=1",
            self.pairing_id,
            self.key_b64url()
        )
    }

    /// Seal an outbound message into an envelope (fresh random nonce per call).
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<RemoteEnvelope, String> {
        encrypt(&self.key, plaintext)
    }

    /// Open an inbound envelope; fails closed on a wrong key or any tampering.
    pub fn decrypt(&self, env: &RemoteEnvelope) -> Result<Vec<u8>, String> {
        decrypt(&self.key, env)
    }
}

impl Default for PairingSession {
    fn default() -> Self {
        Self::new()
    }
}

/// AES-256-GCM seal with a caller-supplied nonce. Returns `ciphertext‖tag`.
fn encrypt_with_nonce(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("invalid key: {e}"))?;
    cipher
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .map_err(|e| format!("encrypt: {e}"))
}

/// Seal `plaintext` into a `{iv, ct}` envelope with a fresh random 96-bit nonce.
pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<RemoteEnvelope, String> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = encrypt_with_nonce(key, &nonce, plaintext)?;
    Ok(RemoteEnvelope {
        iv: URL_SAFE_NO_PAD.encode(nonce),
        ct: URL_SAFE_NO_PAD.encode(ct),
    })
}

/// Open a `{iv, ct}` envelope. The GCM tag is verified; a wrong key or any
/// tampering fails closed (no partial output), mirroring crypto/ §5.
pub fn decrypt(key: &[u8; KEY_LEN], env: &RemoteEnvelope) -> Result<Vec<u8>, String> {
    let nonce = URL_SAFE_NO_PAD
        .decode(&env.iv)
        .map_err(|e| format!("iv base64url: {e}"))?;
    if nonce.len() != NONCE_LEN {
        return Err(format!("iv must be {NONCE_LEN} bytes, got {}", nonce.len()));
    }
    let ct = URL_SAFE_NO_PAD
        .decode(&env.ct)
        .map_err(|e| format!("ct base64url: {e}"))?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("invalid key: {e}"))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "decryption failed (wrong key or tampered ciphertext)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The fixed cross-language vector, produced by Web Crypto in
    // scripts/aesgcm-conformance.mjs. Rust MUST produce byte-identical ciphertext;
    // because AES-GCM is deterministic given key+iv+plaintext, this proves BOTH
    // directions interop (Rust↔WebCrypto). Regenerate with that script if changed.
    const VECTOR_KEY_B64: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const VECTOR_IV_B64: &str = "AAECAwQFBgcICQoL";
    const VECTOR_CT_B64: &str = "PCCgOf_U7jn5OOfuk9NaDuu38xbcWSsZQBPHvz8BaZB8uhGFukGYjW19TS-uDlzWIw";
    const VECTOR_PT: &[u8] = br#"{"v":1,"type":"chat","text":"hi"}"#;

    fn vector_key() -> [u8; 32] {
        URL_SAFE_NO_PAD.decode(VECTOR_KEY_B64).unwrap().try_into().unwrap()
    }

    #[test]
    fn matches_webcrypto_vector() {
        let key = vector_key();
        let nonce: [u8; 12] = URL_SAFE_NO_PAD.decode(VECTOR_IV_B64).unwrap().try_into().unwrap();
        // Rust's ciphertext+tag must equal Web Crypto's, byte for byte.
        let ct = encrypt_with_nonce(&key, &nonce, VECTOR_PT).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(&ct), VECTOR_CT_B64, "Rust ct must match Web Crypto");
        // And Rust decrypts the Web Crypto envelope back to the plaintext.
        let env = RemoteEnvelope { iv: VECTOR_IV_B64.into(), ct: VECTOR_CT_B64.into() };
        assert_eq!(decrypt(&key, &env).unwrap(), VECTOR_PT);
    }

    #[test]
    fn roundtrips_with_random_nonce() {
        let s = PairingSession::new();
        let msg = br#"{"v":1,"type":"chat","text":"what's on my calendar?"}"#;
        let env = s.encrypt(msg).unwrap();
        // fresh nonce each call: same plaintext never yields the same envelope.
        let env2 = s.encrypt(msg).unwrap();
        assert_ne!(env.iv, env2.iv);
        assert_ne!(env.ct, env2.ct);
        assert_eq!(s.decrypt(&env).unwrap(), msg);
    }

    #[test]
    fn wrong_key_fails_closed() {
        let a = PairingSession::new();
        let b = PairingSession::new();
        let env = a.encrypt(b"secret").unwrap();
        assert!(b.decrypt(&env).is_err());
    }

    #[test]
    fn tampered_ct_fails_closed() {
        let key = vector_key();
        let mut env = encrypt(&key, b"secret").unwrap();
        // flip the last base64url char of the ciphertext/tag.
        let mut chars: Vec<char> = env.ct.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
        env.ct = chars.into_iter().collect();
        assert!(decrypt(&key, &env).is_err());
    }

    #[test]
    fn pair_uri_is_well_formed() {
        let s = PairingSession::new();
        let uri = s.pair_uri();
        assert!(uri.starts_with("trenlens://pair?room="));
        assert!(uri.contains(&format!("room={}", s.pairing_id)));
        assert!(uri.contains(&format!("key={}", s.key_b64url())));
        assert!(uri.ends_with("&v=1"));
        // key is 32 bytes → 43 base64url chars (no padding).
        assert_eq!(s.key_b64url().len(), 43);
    }
}
