#!/usr/bin/env node
// Renders the Hirora mark (same geometry as apps/desktop/src/shared/Logo.tsx)
// to PNGs with a tiny dependency-free encoder + 4x4 supersampling.
//   node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INK = [29, 28, 53];
const BLUSH = [244, 163, 180];
const WHITE = [255, 255, 255];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, shade) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const p = shade(((x + (sx + 0.5) / SS) / size) * 64, ((y + (sy + 0.5) / SS) / size) * 64);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distances in the 64-unit design grid.
function roundedRect(x, y, w, h, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// Upper half of a circle (the "h" shoulder / aurora arch).
function upperArc(px, py, cx, cy, r) {
  if (py <= cy) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  return Math.min(Math.hypot(px - (cx - r), py - cy), Math.hypot(px - (cx + r), py - cy));
}
// Same as Logo.tsx: M20 16.5 V49 M20 36.5 A10 10 0 0 1 40 36.5 V49, dot (45,16) r 5.4.
function mark(x, y) {
  if (roundedRect(x, y, 64, 64, 19) > 0) return [0, 0, 0, 0];
  if (Math.hypot(x - 45, y - 16) <= 5.4) return [...BLUSH, 1];
  const h = Math.min(segment(x, y, 20, 16.5, 20, 49), upperArc(x, y, 30, 36.5, 10), segment(x, y, 40, 36.5, 40, 49));
  if (h <= 3.6) return [...WHITE, 1];
  return [...INK, 1];
}

const here = dirname(fileURLToPath(import.meta.url));
const res = resolve(here, '..', 'apps', 'desktop', 'resources');
mkdirSync(res, { recursive: true });
writeFileSync(resolve(res, 'icon.png'), png(512, mark));
writeFileSync(resolve(res, 'tray.png'), png(32, mark));
writeFileSync(resolve(res, 'tray@2x.png'), png(64, mark));
const site = resolve(here, '..', 'apps', 'website', 'public');
mkdirSync(site, { recursive: true });
writeFileSync(resolve(site, 'favicon.png'), png(64, mark));
writeFileSync(resolve(site, 'apple-touch-icon.png'), png(180, mark));
console.log('icons written to', res, 'and', site);
