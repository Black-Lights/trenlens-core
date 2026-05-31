/** @type {import('next').NextConfig} */

// Phase 5: a fully client-side PWA. `output: 'export'` emits static assets into
// `out/` (no Node server), which drops straight onto Cloudflare Pages over HTTPS —
// the secure context the camera (`getUserMedia` QR scan) and the service worker
// require — and lets the SW be served from the origin root (`/sw.js`). Every page is
// `'use client'` (auth, scan, chat), so nothing needs SSR/server components.
//
// `images.unoptimized` is required by `output: 'export'` (no on-demand optimizer);
// `trailingSlash` makes the exported routes (`/scan/`, `/chat/`) resolve cleanly as
// static directories on Pages.
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
