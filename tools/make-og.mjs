#!/usr/bin/env node
// Renders the social card (apps/website/public/img/og.png, 1200x630) in Edge from the brand's
// vector mark and wordmark (brand/*.svg), so the card always matches the logo.
//   node tools/make-og.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = (f) => readFileSync(resolve(root, 'brand', f), 'utf8');
const mark = svg('doing-mark.svg').replace('<svg ', '<svg width="92" height="92" ');
const word = svg('doing-wordmark.svg').replace('<svg ', '<svg height="62" ').replace('stroke="#1d1c35"', 'stroke="#1d1c35"');
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; width: 1200px; height: 630px; background: #f3f2ef; font-family: 'Segoe UI', Arial, sans-serif; color: #1d1c35; display: flex; }
  .card { margin: 40px; flex: 1; background: #fff; border-radius: 34px; padding: 64px 72px; display: flex; flex-direction: column; position: relative; overflow: hidden; }
  .brand { display: flex; align-items: center; gap: 22px; }
  h1 { font-size: 62px; line-height: 1.08; letter-spacing: -0.02em; margin: 56px 0 0; font-weight: 300; max-width: 700px; }
  h1 b { font-weight: 700; }
  p { font-size: 28px; color: #5f5e75; margin: 26px 0 0; }
  .ring { position: absolute; right: -150px; bottom: -150px; width: 480px; height: 480px; border-radius: 50%; border: 2px solid #ece9f4; }
  .ring.two { right: -80px; bottom: -80px; width: 340px; height: 340px; }
  .dot { position: absolute; right: 120px; bottom: 120px; width: 46px; height: 46px; border-radius: 50%; background: #f4a3b4; }
</style><div class="card"><div class="brand">${mark}${word}</div>
<h1>Your meetings, <b>transcribed and answered on your own PC.</b></h1>
<p>Free for Windows. Runs locally, no account.</p>
<div class="ring"></div><div class="ring two"></div><div class="dot"></div></div>`;
const b = await chromium.launch({ channel: 'msedge' });
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(html);
const out = resolve(root, 'apps', 'website', 'public', 'img', 'og.png');
await p.screenshot({ path: out });
await b.close();
console.log('wrote', out);
