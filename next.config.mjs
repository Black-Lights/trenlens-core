/** @type {import('next').NextConfig} */

// Tauri serves the frontend as a static bundle from `dist/` in production and
// proxies to the Next dev server during `tauri dev`. Static export keeps the
// frontend fully client-side so it can run inside the Tauri webview without a
// Node server. IPC to the Rust backend happens via `window.__TAURI__.invoke`.
const nextConfig = {
  // Tauri expects a static, server-less bundle.
  output: 'export',
  distDir: 'dist',
  // Tauri's asset protocol cannot run the Next.js image optimizer.
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
