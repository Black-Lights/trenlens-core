//! BYOK secret sealing (§5).
//!
//! Authenticated row-level encryption for stored provider API keys:
//!   - **Cipher:** AES-256-GCM (AEAD — confidentiality *and* tamper detection).
//!   - **Nonce:** a fresh random 96-bit nonce per `seal`, prepended to the
//!     ciphertext (`nonce ‖ ciphertext`) and base64-encoded into one opaque blob.
//!   - **Master key:** 32 random bytes generated on first launch and persisted in
//!     the **native OS vault** via the `keyring` crate (Windows Credential
//!     Manager / macOS Keychain / Linux Secret Service). It never touches our DB
//!     file or disk, and never crosses the IPC boundary to the front end.
//!
//! The front end only ever handles the sealed base64 strings; plaintext keys are
//! sealed/unsealed here and (later, §6) injected directly into the LiteLLM proxy.
//!
//! Stable-rustc note: `aes-gcm`, `argon2`, `base64`, and `keyring`'s
//! `windows-native` backend are all pure-Rust and compile on stable 1.94+ with no
//! C toolchain.

#![allow(dead_code)]

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// 96-bit GCM nonce, as bytes.
const NONCE_LEN: usize = 12;

/// Service/account under which the master key is filed in the OS vault. Bump the
/// account suffix if the key format ever changes (lets old + new coexist).
const KEYCHAIN_SERVICE: &str = "trenlens-core";
const KEYCHAIN_ACCOUNT: &str = "master-key-v1";

// ── Core AEAD ───────────────────────────────────────────────────────────────

/// Seal plaintext → an opaque blob (`base64(nonce ‖ ciphertext+tag)`).
///
/// A new random 96-bit nonce is generated for every call, so sealing the same
/// plaintext twice yields different blobs — never reuse a (key, nonce) pair.
pub fn seal(master_key: &[u8], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(master_key).map_err(|e| format!("invalid master key: {e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bit, cryptographically random
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("encrypt: {e}"))?;

    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(nonce.as_slice());
    blob.extend_from_slice(&ct);
    Ok(STANDARD.encode(blob))
}

/// Unseal a blob produced by [`seal`] back to plaintext. The GCM tag is verified;
/// a wrong key or any tampering fails closed with an error (no partial output).
pub fn unseal(master_key: &[u8], blob_b64: &str) -> Result<String, String> {
    let blob = STANDARD.decode(blob_b64).map_err(|e| format!("base64 decode: {e}"))?;
    if blob.len() < NONCE_LEN {
        return Err("ciphertext too short (missing nonce)".into());
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(master_key).map_err(|e| format!("invalid master key: {e}"))?;
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "decryption failed (wrong key or tampered ciphertext)".to_string())?;
    String::from_utf8(pt).map_err(|e| format!("plaintext not utf-8: {e}"))
}

/// Optional passphrase path: derive a 32-byte key from a user secret + salt via
/// Argon2id. Not used by the default keychain flow (which stores a random key),
/// but kept available for a future "protect with a passphrase" option (§5).
pub fn derive_master_key(secret: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    use argon2::Argon2;
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(secret, salt, &mut out)
        .map_err(|e| format!("argon2id: {e}"))?;
    Ok(out)
}

// ── OS-keychain-held master key ───────────────────────────────────────────────

/// Fetch the master key from the OS vault, generating + persisting a fresh random
/// 32-byte key on the very first launch (when no entry exists yet).
///
/// The key is stored base64-encoded as the credential "password" — the most
/// portable representation across every `keyring` backend.
fn load_or_create_master_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keychain entry: {e}"))?;

    match entry.get_password() {
        Ok(b64) => {
            let bytes = STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("decoding stored master key: {e}"))?;
            let key: [u8; 32] = bytes
                .as_slice()
                .try_into()
                .map_err(|_| "stored master key is not 32 bytes".to_string())?;
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            // First launch: mint a 256-bit key and file it in the OS vault.
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD.encode(key))
                .map_err(|e| format!("persisting master key to keychain: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("reading master key from keychain: {e}")),
    }
}

/// Tauri-managed crypto boundary. Holds the master key in memory for the process
/// lifetime; `seal_data` / `unseal_data` IPC commands delegate here. The key bytes
/// never leave this struct (a future hardening could zeroize-on-drop).
pub struct CryptoState {
    master_key: [u8; 32],
}

impl CryptoState {
    /// Initialise the vault: load-or-create the master key from the OS keychain.
    /// Called once from the Tauri `setup` hook.
    pub fn init() -> Result<Self, String> {
        Ok(Self {
            master_key: load_or_create_master_key()?,
        })
    }

    pub fn seal(&self, plaintext: &str) -> Result<String, String> {
        seal(&self.master_key, plaintext)
    }

    pub fn unseal(&self, blob_b64: &str) -> Result<String, String> {
        unseal(&self.master_key, blob_b64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        // Deterministic key for unit tests (NOT how production keys are made).
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn seal_roundtrips() {
        let key = test_key();
        let secret = "sk-ant-api03-PLAINTEXT-SECRET";
        let blob = seal(&key, secret).unwrap();
        assert_ne!(blob, secret, "blob must not contain the plaintext verbatim");
        assert_eq!(unseal(&key, &blob).unwrap(), secret);
    }

    #[test]
    fn nonce_is_per_call() {
        let key = test_key();
        let a = seal(&key, "same").unwrap();
        let b = seal(&key, "same").unwrap();
        assert_ne!(a, b, "fresh nonce must make each blob unique");
        assert_eq!(unseal(&key, &a).unwrap(), "same");
        assert_eq!(unseal(&key, &b).unwrap(), "same");
    }

    #[test]
    fn wrong_key_fails_closed() {
        let blob = seal(&test_key(), "secret").unwrap();
        let mut other = test_key();
        other[0] ^= 0xff;
        assert!(unseal(&other, &blob).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails_closed() {
        let key = test_key();
        let blob = seal(&key, "secret").unwrap();
        let mut raw = STANDARD.decode(&blob).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01; // flip a tag/ciphertext bit
        assert!(unseal(&key, &STANDARD.encode(raw)).is_err());
    }
}
