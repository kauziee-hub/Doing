#!/usr/bin/env node
// Copies the latest built installer + real app screenshots into the website and
// writes src/release.json (version, size, SHA-256). Nothing here is invented:
// if no installer exists, the site shows a "not built yet" state.
//
// HIRORA_DOWNLOAD_URL=https://.../Hirora-Setup-x.y.z-x64-unsigned.exe points the
// download buttons at a release host (e.g. GitHub Releases) instead of bundling the
// ~110 MB installer into the static site. Size and SHA-256 still come from the
// local file, so the published checksum always matches what was built.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const root = resolve(site, '..', '..');
const releaseDir = join(root, 'apps', 'desktop', 'release');
const desktopPkg = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
const externalUrl = process.env.HIRORA_DOWNLOAD_URL?.trim() || null;
if (externalUrl && !/^https:\/\//.test(externalUrl)) throw new Error('HIRORA_DOWNLOAD_URL must be an https:// URL');

const out = { version: desktopPkg.version, file: null, url: externalUrl, sizeBytes: null, sha256: null, builtAt: null, signed: false };
const downloads = join(site, 'public', 'download');
// Never ship a stale or differently-named installer next to the current one.
rmSync(downloads, { recursive: true, force: true });

if (existsSync(releaseDir)) {
  const exe = readdirSync(releaseDir)
    .filter((f) => f === `Hirora-Setup-${desktopPkg.version}-x64-unsigned.exe`)
    .map((f) => ({ f, t: statSync(join(releaseDir, f)).mtimeMs }))[0];
  if (exe) {
    const src = join(releaseDir, exe.f);
    const bytes = readFileSync(src);
    if (!externalUrl) {
      mkdirSync(downloads, { recursive: true });
      copyFileSync(src, join(downloads, exe.f));
    }
    out.file = `download/${exe.f}`;
    out.sizeBytes = bytes.length;
    out.sha256 = createHash('sha256').update(bytes).digest('hex');
    out.builtAt = new Date(exe.t).toISOString();
  }
}
if (!out.file) out.url = null;

const shots = join(root, 'test-results', 'screenshots');
// Real captures of the app from a fresh profile (tools/site-shots.mjs), using the engine on this PC.
const want = {
  'home-light.png': ['local-home-light.png'],
  'home-dark.png': ['local-home-dark.png'],
  'overlay.png': ['local-overlay.png'],
  'engine.png': ['local-engine.png'],
};
mkdirSync(join(site, 'public', 'img'), { recursive: true });
for (const [dest, candidates] of Object.entries(want)) {
  const src = candidates.find((c) => existsSync(join(shots, c)));
  if (src) copyFileSync(join(shots, src), join(site, 'public', 'img', dest));
}
writeFileSync(join(site, 'src', 'release.json'), JSON.stringify(out, null, 2));
console.log('release:', out.file ? `${out.url ?? out.file} (${(out.sizeBytes / 1048576).toFixed(1)} MB) sha256 ${out.sha256}` : 'no installer built yet');
