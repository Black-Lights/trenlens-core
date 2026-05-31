/** @type {import('next').NextConfig} */

// Phase 1: a normal Next.js app served by `next dev`/`next start` so we can
// exercise Supabase auth on a mobile-sized screen. Phase 5 turns this into an
// installable PWA (web app manifest + service worker) deployed to Cloudflare
// Pages over HTTPS — required for camera `getUserMedia` (QR scan) and SWs.
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
