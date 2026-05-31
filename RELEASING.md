# Releasing (signed, auto-updatable)

TrenLens ships in-app auto-updates via `tauri-plugin-updater`. Each release must be
**signed** with the project's minisign key and described by a `latest.json` manifest
that the app polls.

## One-time setup (done)

- Signing keypair generated with `tauri signer generate`.
  - **Public key** → `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
  - **Private key** → kept OUTSIDE the repo at `~/.tauri/trenlens.key`. **Never commit it.**
    Back it up; if it's lost, existing installs can no longer verify updates and must
    be reinstalled manually.
- Update endpoint (in `tauri.conf.json`):
  `https://raw.githubusercontent.com/Black-Lights/trenlens-core/main/latest.json`
- `bundle.createUpdaterArtifacts: true` makes the bundler emit `.sig` files.

## Cutting a release

1. **Bump the version** — keep these in sync to the SAME string (e.g. `0.1.0-alpha.2`):
   `src/lib/appInfo.ts` (`APP_VERSION`), `package.json`, and **`src-tauri/tauri.conf.json`**.
   The updater compares the running binary's version (from `tauri.conf.json`) against
   the manifest, so the binary MUST carry the same `-alpha.N` scheme — otherwise a
   pre-release manifest semver-compares as older than a plain `0.1.0` binary and never
   triggers. (`Cargo.toml` may stay as-is; `tauri.conf.json` takes precedence.)

2. **Build, signed** — feed the private key via env (never echo it):
   ```bash
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/trenlens.key)" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
   npm run tauri:build
   ```
   Output (Windows):
   - `src-tauri/target/release/bundle/nsis/*-setup.exe` + `*-setup.exe.sig`

   > **MSI note:** the bundle targets only `nsis`. WiX/MSI rejects non-numeric
   > pre-release identifiers (`-alpha.N`), and NSIS is what the updater uses on
   > Windows anyway. To also ship an MSI, override the MSI version with a numeric
   > one via `bundle.windows.wix.version`, or use a numeric pre-release (`-1`).

3. **Create the GitHub (pre-)release** and upload the installer:
   ```bash
   gh release create vX.Y.Z-alpha.N --prerelease --title "…" --notes-file notes.md
   gh release upload  vX.Y.Z-alpha.N "…/nsis/…-setup.exe"
   ```

4. **Write `latest.json`** (repo root) and commit it to `main` — the app reads it
   from the raw URL above:
   ```json
   {
     "version": "X.Y.Z-alpha.N",
     "pub_date": "<ISO-8601>",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the -setup.exe.sig file>",
         "url": "<the uploaded asset's browser_download_url>"
       }
     }
   }
   ```
   `version` must be **greater** than the running app's `APP_VERSION` (semver, incl.
   pre-release ordering) for clients to offer the update.

5. Installed clients pick it up on the next **Check for updates** (About dialog):
   download → signature verify → install → relaunch.

## CI alternative

`tauri-apps/tauri-action` automates steps 2–4 (build, sign, draft release, generate
`latest.json`). Store the private key + password as repo **secrets**
(`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
