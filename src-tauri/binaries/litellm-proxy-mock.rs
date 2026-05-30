//! Mock LiteLLM sidecar for trenlens-core (§6) — DEV SCAFFOLD ONLY.
//!
//! Stands in for the real PyInstaller-packaged `litellm --config <yaml>` proxy so
//! the Rust sidecar-supervision wiring (spawn → stdout bind detection → kill) can
//! be exercised end-to-end WITHOUT a Python toolchain. It prints the exact bind
//! line the supervisor watches for, then idles until the parent kills it.
//!
//! Regenerate the platform binary (must keep the target-triple suffix so Tauri's
//! `externalBin` resolution + `generate_context!` find it):
//!
//!   Windows:  rustc -O litellm-proxy-mock.rs -o litellm-proxy-x86_64-pc-windows-msvc.exe
//!   macOS:    rustc -O litellm-proxy-mock.rs -o litellm-proxy-aarch64-apple-darwin
//!   Linux:    rustc -O litellm-proxy-mock.rs -o litellm-proxy-x86_64-unknown-linux-gnu
//!
//! Replace with the real PyInstaller bundle (`litellm[proxy]` → onefile) before
//! shipping; the Rust supervisor and IPC contract stay identical.

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = std::io::stdout();
    let _ = writeln!(out, "INFO: litellm-proxy mock starting (args: {args:?})");
    // The supervisor's bind detector matches "running" + "127.0.0.1:<port>".
    let _ = writeln!(out, "INFO: Proxy running on http://127.0.0.1:4000");
    let _ = out.flush();

    // Idle until the parent process terminates us (CommandChild::kill).
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
