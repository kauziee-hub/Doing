#!/usr/bin/env node
// `pnpm perf` — runs the in-app local benchmarks (no network, no keys) against the
// built app on a throw-away profile and writes tests/performance/results/local-<ts>.json.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('@playwright/test');
const userData = mkdtempSync(join(tmpdir(), 'hirora-perf-'));
const app = await _electron.launch({
  executablePath: join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [join(root, 'apps', 'desktop')],
  env: { ...process.env, HIRORA_USER_DATA: userData },
});
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
  if (!dash) await new Promise((r) => setTimeout(r, 250));
}
const results = await dash.evaluate(() => window.hirora.invoke('perf:runLocalBench'));
await app.close();
rmSync(userData, { recursive: true, force: true });
const out = join(root, 'tests', 'performance', 'results');
mkdirSync(out, { recursive: true });
const file = join(out, `local-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.table(results);
console.log('written', file);
