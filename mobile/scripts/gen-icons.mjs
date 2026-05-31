#!/usr/bin/env node
/**
 * Generate the PWA icons with no dependencies (pure Node: zlib + manual PNG chunks).
 *
 * Draws the TrenLens mark — a pulse-accent disc on the app's dark canvas — at the
 * sizes the manifest + iOS need. Re-run with `node scripts/gen-icons.mjs` to refresh;
 * the PNGs are committed so the static export doesn't depend on this at build time.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG = [11, 15, 23, 255]; // #0b0f17 canvas
const FG = [91, 140, 255, 255]; // #5b8cff pulse

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, { maskable = false } = {}) {
  const w = size;
  const h = size;
  const cx = w / 2;
  const cy = h / 2;
  // Maskable icons must keep the mark inside the ~80% safe zone; normal can be larger.
  const r = (maskable ? 0.3 : 0.42) * size;
  const r2 = r * r;

  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const [R, G, B, A] = dx * dx + dy * dy <= r2 ? FG : BG;
      const p = row + 1 + x * 4;
      raw[p] = R;
      raw[p + 1] = G;
      raw[p + 2] = B;
      raw[p + 3] = A;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const files = {
  'icon-192.png': png(192),
  'icon-512.png': png(512),
  'maskable-512.png': png(512, { maskable: true }),
  'apple-touch-icon.png': png(180),
};
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(new URL(name, outDir), buf);
  console.log(`wrote public/icons/${name} (${buf.length} bytes)`);
}
