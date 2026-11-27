#!/usr/bin/env node
// Renders the Doing mark (same geometry as brand/doing-mark.svg and apps/desktop/src/shared/Logo.tsx)
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
// Same as brand/doing-mark.svg: the wordmark's D (stroke 22, miter corners) at translate(13 15)
// scale(0.34) on the ink squircle, and the blush dot the ı gave up at (48.5, 17) r 5.6.
function inD(x, y) {
  const u = (x - 13) / 0.34;
  const v = (y - 15) / 0.34;
  if (u < 0 || v < 0 || v > 100) return false;
  if (u <= 22) return true; // stem
  if (u <= 40) return v <= 22 || v >= 78; // top and bottom bars
  return Math.abs(Math.hypot(u - 40, v - 50) - 39) <= 11; // bowl
}
function mark(x, y) {
  if (roundedRect(x, y, 64, 64, 19) > 0) return [0, 0, 0, 0];
  if (Math.hypot(x - 48.5, y - 17) <= 5.6) return [...BLUSH, 1];
  if (inD(x, y)) return [...WHITE, 1];
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
