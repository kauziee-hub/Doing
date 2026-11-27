/**
 * Screen-share check against a REAL browser share: Microsoft Edge's getDisplayMedia
 * ("Entire screen"), the path Google Meet and other browser meetings use.
 *
 * A fresh Doing profile paints its overlay with a solid probe colour; Edge shares the
 * screen and the test samples the overlay's area in the shared video. Protection off
 * is the baseline (the share must show the probe, otherwise the method can't be judged).
 *
 * Needs an interactive Windows desktop with Edge installed: `pnpm build` first, then
 * `npx playwright test -c tests/e2e/playwright.config.ts capture`.
 */
import { _electron as electron, chromium, expect, test } from '@playwright/test';
import type { Browser, ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'apps', 'desktop');
const INSTALLED = process.env.DOING_E2E_EXE;
const ELECTRON = INSTALLED ?? join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PAINT_FLAGS = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];
const LAUNCH_ARGS = INSTALLED ? PAINT_FLAGS : [...PAINT_FLAGS, APP_DIR];
/** Must match PROBE_RGB in apps/desktop/electron/main/capture.ts (the overlay's captureProbe colour). */
const PROBE = { r: 255, g: 0, b: 255 };

type Rgb = { r: number; g: number; b: number };
type Bridge = { doing: { invoke: (c: string, p?: unknown) => Promise<unknown> } };
const dist = (a: Rgb, b: Rgb) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><title>share probe</title>
<button id="go">Share screen</button><video id="v" muted playsinline style="width:200px"></video>
<script>
document.getElementById('go').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    const v = document.getElementById('v');
    v.srcObject = s;
    await v.play();
    window.__share = { stream: s, label: s.getVideoTracks()[0].label };
  } catch (e) { window.__share = { error: String(e) }; }
};
// Average colour of a rectangle given as fractions of the shared frame.
window.__sample = async (fx, fy, fw, fh) => {
  const v = document.getElementById('v');
  await new Promise((r) => v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => r()) : setTimeout(r, 200));
  const W = v.videoWidth, H = v.videoHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, W, H);
  const x = Math.round(fx * W), y = Math.round(fy * H), w = Math.max(1, Math.round(fw * W)), h = Math.max(1, Math.round(fh * H));
  const d = g.getImageData(x, y, w, h).data;
  let r = 0, gg = 0, b = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  return { r: r / n, g: gg / n, b: b / n, W, H };
};
</script>`;

let app: ElectronApplication;
let userData: string;
let server: Server;
let browser: Browser;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'doing-capture-'));
  app = await electron.launch({ executablePath: ELECTRON, args: LAUNCH_ARGS, env: { ...process.env, DOING_USER_DATA: userData, NODE_ENV: 'production' , DOING_ENGINE_DIR: join(userData, 'engine'), DOING_ENGINE_MODELS: join(userData, 'engine', 'models'), DOING_ENGINE_NO_SYSTEM_OLLAMA: '1' } });
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  server?.close();
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* db may still be held for a moment */
  }
});

async function windowByTitle(title: string): Promise<Page> {
  for (let i = 0; i < 60; i++) {
    for (const w of app.windows()) if ((await w.title().catch(() => '')) === title) return w;
    await sleep(250);
  }
  throw new Error(`window "${title}" not found`);
}
const dashboard = () => windowByTitle('Doing');

test('the overlay is left out of a real browser screen share, on by default', async () => {
  const dash = await dashboard();
  const settings = (await dash.evaluate(() => (window as unknown as Bridge).doing.invoke('settings:get'))) as { overlay: { contentProtection: boolean } };
  expect(settings.overlay.contentProtection).toBe(true);

  // Show the overlay the way the hotkey does, then paint the probe (as the in-app check does).
  await dash.evaluate(() => (window as unknown as Bridge).doing.invoke('overlay:toggle'));
  const overlay = await windowByTitle('Doing Overlay');
  await overlay.waitForSelector('.ov-input, textarea, input', { timeout: 15_000 }); // renderer is up
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Doing Overlay')!;
    w.setOpacity(1);
    w.webContents.send('doing:live', { type: 'command', command: 'captureProbe', arg: true });
  });
  await overlay.waitForSelector('.ov-probe', { timeout: 5_000 });
  const geo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Doing Overlay')!;
    const b = w.getBounds();
    const d = screen.getDisplayMatching(b);
    return { b, d: d.bounds, primary: d.id === screen.getPrimaryDisplay().id, displays: screen.getAllDisplays().length };
  });
  expect(geo.primary, 'overlay should open on the primary display').toBe(true);
  // Central 50% of the overlay, as fractions of the display (scale-independent).
  const frac = {
    x: (geo.b.x - geo.d.x + geo.b.width * 0.25) / geo.d.width,
    y: (geo.b.y - geo.d.y + geo.b.height * 0.25) / geo.d.height,
    w: (geo.b.width * 0.5) / geo.d.width,
    h: (geo.b.height * 0.5) / geo.d.height,
  };

  // Edge picks the primary screen automatically (no picker): "Entire screen" with one monitor, "Screen 1" with more.
  const source = geo.displays > 1 ? 'Screen 1' : 'Entire screen';
  browser = await chromium.launch({
    channel: process.env.DOING_SHARE_CHANNEL ?? 'msedge', // 'chrome' to use installed Google Chrome
    headless: false,
    args: [`--auto-select-desktop-capture-source=${source}`, '--use-fake-ui-for-media-stream', '--window-position=40,40', '--window-size=420,320'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await page.click('#go');
  await page.waitForFunction(() => (window as unknown as { __share?: unknown }).__share, null, { timeout: 15_000 });
  const share = await page.evaluate(() => (window as unknown as { __share: { label?: string; error?: string } }).__share);
  expect(share.error, 'getDisplayMedia failed').toBeUndefined();
  console.log(`${process.env.DOING_SHARE_CHANNEL ?? 'msedge'} ${browser.version()} sharing "${share.label}"`);

  const sample = async (): Promise<Rgb & { W: number; H: number }> => {
    await sleep(700); // let a few new frames arrive after a change
    return page.evaluate((f) => (window as unknown as { __sample: (...a: number[]) => Promise<Rgb & { W: number; H: number }> }).__sample(f.x, f.y, f.w, f.h), frac);
  };
  const setProtection = (on: boolean) => dash.evaluate((v) => (window as unknown as Bridge).doing.invoke('settings:update', { overlay: { contentProtection: v } }), on);
  const fmt = (c: Rgb) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;

  const byDefault = await sample();
  await setProtection(false);
  const baseline = await sample();
  await setProtection(true);
  const turnedOn = await sample();
  // Hide and show again (Ctrl+Shift+Space twice) — protection must survive it.
  await dash.evaluate(() => (window as unknown as Bridge).doing.invoke('overlay:toggle'));
  await dash.evaluate(() => (window as unknown as Bridge).doing.invoke('overlay:toggle'));
  const afterReshow = await sample();
  console.log(
    `shared frame ${byDefault.W}x${byDefault.H}; probe ${fmt(PROBE)}; default ${fmt(byDefault)}; protection off ${fmt(baseline)}; on ${fmt(turnedOn)}; after hide/show ${fmt(afterReshow)}`,
  );

  expect(dist(baseline, PROBE), 'baseline: with protection off the share must show the overlay').toBeLessThan(60);
  expect(dist(byDefault, PROBE), 'default: overlay must not appear in the share').toBeGreaterThan(120);
  expect(dist(turnedOn, PROBE), 'toggled back on: overlay must not appear in the share').toBeGreaterThan(120);
  expect(dist(afterReshow, PROBE), 'after hide/show: overlay must not appear in the share').toBeGreaterThan(120);

  // The main window follows the same setting (it can show the résumé, transcript and answers).
  await dash.evaluate(() => (window as unknown as Bridge).doing.invoke('overlay:toggle')); // hide the overlay
  const dashGeo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Doing')!;
    const d = screen.getPrimaryDisplay().bounds;
    w.setBounds({ x: d.x + Math.round(d.width * 0.45), y: d.y + Math.round(d.height * 0.2), width: 920, height: 620 });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.show();
    return { b: w.getBounds(), d };
  });
  await dash.evaluate((rgb) => {
    const el = document.createElement('div');
    el.id = 'dash-probe';
    el.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgb(${rgb.r},${rgb.g},${rgb.b})`;
    document.body.appendChild(el);
  }, PROBE);
  const dashFrac = {
    x: (dashGeo.b.x - dashGeo.d.x + dashGeo.b.width * 0.25) / dashGeo.d.width,
    y: (dashGeo.b.y - dashGeo.d.y + dashGeo.b.height * 0.25) / dashGeo.d.height,
    w: (dashGeo.b.width * 0.5) / dashGeo.d.width,
    h: (dashGeo.b.height * 0.5) / dashGeo.d.height,
  };
  const sampleDash = async (): Promise<Rgb> => {
    await sleep(700);
    return page.evaluate((f) => (window as unknown as { __sample: (...a: number[]) => Promise<Rgb> }).__sample(f.x, f.y, f.w, f.h), dashFrac);
  };
  const dashOn = await sampleDash();
  await setProtection(false);
  const dashOff = await sampleDash();
  await setProtection(true);
  const dashBackOn = await sampleDash();
  console.log(`main window: protection on ${fmt(dashOn)}; off ${fmt(dashOff)}; back on ${fmt(dashBackOn)}`);
  expect(dist(dashOff, PROBE), 'baseline: with protection off the share must show the main window').toBeLessThan(60);
  expect(dist(dashOn, PROBE), 'main window must not appear in the share').toBeGreaterThan(120);
  expect(dist(dashBackOn, PROBE), 'main window, toggled back on: must not appear in the share').toBeGreaterThan(120);
});
