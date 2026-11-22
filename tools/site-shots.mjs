#!/usr/bin/env node
// Real screenshots of the app for the website, taken from a FRESH profile (no personal
// data) using the engine already installed on this PC. Writes test-results/screenshots/
// local-home-light.png, local-home-dark.png, local-engine.png and local-overlay.png.
//   node tools/site-shots.mjs [--exe <Hirora.exe>]
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const exeIdx = args.indexOf('--exe');
const APP = resolve('apps/desktop');
const exe = exeIdx >= 0 ? args[exeIdx + 1] : join(APP, 'node_modules/electron/dist/electron.exe');
const launchArgs = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', ...(exeIdx >= 0 ? [] : [APP])];
const out = resolve('test-results/screenshots');
mkdirSync(out, { recursive: true });
const ud = mkdtempSync(join(tmpdir(), 'hirora-shots-'));
const app = await electron.launch({ executablePath: exe, args: launchArgs, env: { ...process.env, HIRORA_USER_DATA: ud, NODE_ENV: 'production' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byTitle = async (t) => {
  for (let i = 0; i < 80; i++) {
    for (const w of app.windows()) if ((await w.title().catch(() => '')) === t) return w;
    await sleep(250);
  }
  throw new Error(`no window ${t}`);
};
const dash = await byTitle('Hirora');
const call = (c, p) => dash.evaluate(([c, p]) => window.hirora.invoke(c, p), [c, p]);
await call('settings:update', { onboardingComplete: true, answer: { mode: 'coding' } });
// Settings changes re-apply screen-capture protection, and a window behind others stops
// painting: before every shot, bring the window forward with protection off (this capture only).
// Electron's own capture of the window's last frame (Playwright's screenshot can wait forever).
const shot = async (title, file) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === t);
    w.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 400));
    return (await w.webContents.capturePage()).toPNG().toString('base64');
  }, title);
  writeFileSync(join(out, file), Buffer.from(b64, 'base64'));
};
const ready = (title) =>
  app.evaluate(({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === t);
    w.setContentProtection(false);
    w.showInactive();
    w.moveTop();
  }, title);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Hirora').setSize(1280, 860));
const st = await call('engine:status');
if (!st.ready) throw new Error('engine not installed on this PC');
for (const theme of ['light', 'dark']) {
  await call('settings:update', { appearance: { theme } });
  await dash.reload();
  await dash.getByRole('heading', { name: /Ready when/ }).waitFor();
  await ready('Hirora');
  await sleep(800);
  await shot('Hirora', `local-home-${theme}.png`);
}
await call('settings:update', { appearance: { theme: 'light' } });
await dash.reload();
await dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
await dash.getByRole('tab', { name: 'Engine' }).click();
await ready('Hirora');
await sleep(600);
await shot('Hirora', 'local-engine.png');

// Overlay with a real answer from the local model.
await call('overlay:toggle');
await byTitle('Hirora Overlay');
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Hirora Overlay');
  w.setContentProtection(false);
  w.setBounds({ x: 60, y: 60, width: 460, height: 640 });
});
// Wait for the model to be loaded (the app warms up at launch).
for (let i = 0; i < 240; i++) {
  const p = await call('perf:summary');
  if ((p.recent ?? []).some((r) => r.label === 'model-load')) break;
  await sleep(500);
}
const r = await call('ask:text', { text: 'Write a function that checks whether a string has balanced brackets.', mode: 'coding' });
await dash.evaluate((id) => new Promise((res) => {
  const off = window.hirora.onLive((e) => {
    if (e.type === 'answer' && e.answer.requestId === id && ['done', 'error'].includes(e.answer.status)) {
      off();
      res(null);
    }
  });
}), r.requestId);
await ready('Hirora Overlay');
await sleep(800);
await shot('Hirora Overlay', 'local-overlay.png');
await app.close();
rmSync(ud, { recursive: true, force: true });
console.log('saved', ['local-home-light.png', 'local-home-dark.png', 'local-engine.png', 'local-overlay.png'].map((f) => join(out, f)).join('\n'));
