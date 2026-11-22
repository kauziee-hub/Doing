#!/usr/bin/env node
// Fresh-PC setup check: launches Hirora with a NEW profile and an EMPTY engine folder (no
// system Ollama, no models), presses "Set up" through the real IPC, and records every
// download, checksum, unpack and model pull as it happens, then asks typed questions and
// reports the answers and their first-token latency. Real network, real files.
//   node tools/engine-setup-check.mjs <engineDir> [--tier cpu|gpu] [--exe <Hirora.exe>] [--keep]
// --tier cpu also sets HIRORA_ENGINE_FORCE_CPU=1 so the answer model stays off the GPU,
// which is what a PC without an NVIDIA card gets.
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const engineDir = resolve(args[0] ?? join(tmpdir(), 'hirora-engine-check'));
const tier = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : 'cpu';
const exeIdx = args.indexOf('--exe');
const APP = resolve('apps/desktop');
const exe = exeIdx >= 0 ? args[exeIdx + 1] : join(APP, 'node_modules/electron/dist/electron.exe');
const launchArgs = ['--disable-features=CalculateNativeWinOcclusion', ...(exeIdx >= 0 ? [] : [APP])];
mkdirSync(engineDir, { recursive: true });
const ud = mkdtempSync(join(tmpdir(), 'hirora-setup-profile-'));
const env = {
  ...process.env,
  HIRORA_USER_DATA: ud,
  HIRORA_ENGINE_DIR: engineDir,
  HIRORA_ENGINE_MODELS: join(engineDir, 'models-ollama'),
  HIRORA_ENGINE_NO_SYSTEM_OLLAMA: '1',
  ...(tier === 'cpu' ? { HIRORA_ENGINE_FORCE_CPU: '1' } : {}),
};
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s`;
const app = await electron.launch({ executablePath: exe, args: launchArgs, env });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Hirora') dash = w;
  if (!dash) await new Promise((r) => setTimeout(r, 250));
}
const call = (c, p) => dash.evaluate(([c, p]) => window.hirora.invoke(c, p), [c, p]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call('settings:update', { engine: { tier }, onboardingComplete: true });
let st = await call('engine:status');
console.log(`${stamp()} tier=${st.tier} gpu=${st.gpu?.name ?? 'none'} ready=${st.ready} download=${(st.downloadBytes / 1e9).toFixed(2)} GB free=${((st.freeDiskBytes ?? 0) / 1e9).toFixed(1)} GB`);
for (const c of st.components) console.log(`${stamp()}   ${c.label}: ${c.state} · ${c.detail}`);
await call('engine:setup');
const seen = new Map();
for (;;) {
  st = await call('engine:status');
  for (const c of st.components) {
    const key = `${c.state}`;
    if (seen.get(c.id) !== key) {
      seen.set(c.id, key);
      console.log(`${stamp()} ${c.label}: ${c.state}${c.state === 'downloading' ? ` (${(c.bytesTotal / 1e9).toFixed(2)} GB)` : ''}${c.error ? ` — ${c.error}` : ''}`);
    }
  }
  if (st.setup !== 'running') break;
  await sleep(1000);
}
console.log(`${stamp()} setup=${st.setup} ready=${st.ready}${st.error ? ` error=${st.error}` : ''}`);
let exitCode = st.ready ? 0 : 1;
if (st.ready) {
  // The app warms up after setup (starts both servers, loads the model, pre-reads).
  for (let i = 0; i < 600; i++) {
    const p = await call('perf:summary');
    if ((p.recent ?? []).some((r) => r.label === 'model-load')) {
      console.log(`${stamp()} warm-up: ${(p.recent ?? []).filter((r) => r.stage === 'provider_preconnect').map((r) => `${r.label} ${Math.round(r.ms)} ms`).join(', ')}`);
      break;
    }
    await sleep(500);
  }
  await dash.evaluate(() => {
    window.__ans = {};
    window.hirora.onLive((e) => {
      if (e.type === 'answer') window.__ans[e.answer.requestId] = e.answer;
    });
  });
  for (const q of ['What is the difference between a process and a thread?', 'Explain what a REST API is.', 'What is a hash map and when would you use one?']) {
    const r = await call('ask:text', { text: q });
    for (let i = 0; i < 240; i++) {
      const a = (await dash.evaluate(() => window.__ans))[r.requestId];
      if (a && ['done', 'error', 'cancelled'].includes(a.status)) {
        console.log(`${stamp()} Q: ${q}\n        → ${a.status} first token ${a.firstTokenMs} ms, total ${a.totalMs} ms (${a.model})${a.error ? ` ${a.error}` : ''}\n        ${(a.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
        if (a.status !== 'done') exitCode = 1;
        break;
      }
      await sleep(500);
    }
  }
}
await app.close();
rmSync(ud, { recursive: true, force: true });
if (!args.includes('--keep')) rmSync(engineDir, { recursive: true, force: true });
process.exit(exitCode);
