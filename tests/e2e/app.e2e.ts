/**
 * End-to-end tests against the REAL built Electron app (pnpm build first).
 * Each run uses a brand-new temporary profile AND an empty engine folder (no Ollama, no
 * models): exactly what a friend sees after installing. Nothing is mocked; the engine
 * download itself is exercised by tools/engine-setup-check.mjs.
 */
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'apps', 'desktop');
// HIRORA_E2E_EXE=<path to installed Hirora.exe> runs the suite against an installed build.
const INSTALLED = process.env.HIRORA_E2E_EXE;
const ELECTRON = INSTALLED ?? join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
// Keep painting even when other windows cover the app (Chromium's native occlusion
// tracking otherwise stops frames, and page.screenshot() waits forever).
const PAINT_FLAGS = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];
const LAUNCH_ARGS = INSTALLED ? PAINT_FLAGS : [...PAINT_FLAGS, APP_DIR];
const SHOTS = join(ROOT, 'test-results', 'screenshots');

let app: ElectronApplication;
let userData: string;
let engineDir: string;

/** Screenshots are evidence, not assertions: never let an unpainted (covered) window fail a test. */
async function snap(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: join(SHOTS, name), timeout: 8_000 });
  } catch (err) {
    console.warn(`screenshot ${name} skipped: ${(err as Error).message.split(/\r?\n/)[0]}`);
  }
}

async function windowByTitle(title: string): Promise<Page> {
  for (let i = 0; i < 60; i++) {
    for (const w of app.windows()) {
      if ((await w.title().catch(() => '')) === title) return w;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`window "${title}" not found`);
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'hirora-e2e-'));
  engineDir = mkdtempSync(join(tmpdir(), 'hirora-e2e-engine-'));
  app = await electron.launch({
    executablePath: ELECTRON,
    args: LAUNCH_ARGS,
    env: {
      ...process.env,
      HIRORA_USER_DATA: userData,
      NODE_ENV: 'production',
      HIRORA_ENGINE_DIR: engineDir,
      HIRORA_ENGINE_MODELS: join(engineDir, 'models'),
      HIRORA_ENGINE_NO_SYSTEM_OLLAMA: '1',
    },
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  try {
    rmSync(userData, { recursive: true, force: true });
    rmSync(engineDir, { recursive: true, force: true });
  } catch {
    /* windows may still hold the db for a moment */
  }
});

test('fresh install opens on a one-click setup with no keys anywhere', async () => {
  const dash = await windowByTitle('Doing');
  await expect(dash.getByRole('dialog')).toBeVisible();
  await expect(dash.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await expect(dash.getByText(/Everything runs on this PC/)).toBeVisible();
  await snap(dash, '01-onboarding-welcome.png');
  await dash.getByRole('button', { name: 'Next' }).click();
  await expect(dash.getByRole('heading', { name: 'Set up', exact: true })).toBeVisible();
  // Real hardware detection and the real component list, nothing installed yet.
  const dlg = dash.getByRole('dialog');
  for (const label of ['Answer engine', 'Speech recognition', 'Speech model', 'Answer model']) await expect(dlg.getByText(label, { exact: true })).toBeVisible();
  await expect(dlg.getByText(/One-time download of \d/)).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Set up Doing' })).toBeEnabled();
  await expect(dash.getByText(/api key|access code/i)).toHaveCount(0);
  await snap(dash, '02-onboarding-setup.png');
  await dash.getByRole('button', { name: 'Skip' }).click();
  await expect(dash.getByRole('heading', { name: /Your meetings/ })).toBeVisible();
  await expect(dash.getByRole('heading', { name: 'Set up Doing' })).toBeVisible();
  await expect(dash.getByRole('button', { name: 'Finish setup to start' })).toBeDisabled();
  await snap(dash, '03-home-setup.png');
});

test('every page is navigable without keys', async () => {
  const dash = await windowByTitle('Doing');
  const titles: Record<string, RegExp> = { 'Prep: profile and documents': /prep/i, History: /history/i, Settings: /settings/i, 'About & privacy': /privacy/i, Meetings: /meetings/i };
  for (const [page, title] of Object.entries(titles)) {
    const btn = dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: page, exact: true });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-current', 'page');
    await expect(dash.locator('h1.dash-page-title')).toHaveText(title);
  }
  await dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  for (const tab of ['Engine', 'Audio', 'Answers', 'Overlay & capture', 'Hotkeys', 'Privacy & data', 'Updates', 'Performance']) {
    await dash.getByRole('tab', { name: tab }).click();
    await expect(dash.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
  // One assistant: no mode picker, just how answers read and whether it may look at the screen.
  await dash.getByRole('tab', { name: 'Answers' }).click();
  await expect(dash.getByText('Your screen', { exact: true })).toBeVisible();
  await expect(dash.getByText(/^(Mode|Default mode)$/)).toHaveCount(0);
  await dash.getByRole('tab', { name: 'Audio' }).click();
  // Real device enumeration through the native helper.
  await expect(dash.locator('select').first()).toBeVisible();
  await snap(dash, '04-settings-audio.png');
});

test('light and dark themes render', async () => {
  const dash = await windowByTitle('Doing');
  type B = { hirora: { invoke: (c: string, p?: unknown) => Promise<unknown> } };
  for (const theme of ['light', 'dark'] as const) {
    await dash.evaluate((t) => (window as unknown as B).hirora.invoke('settings:update', { appearance: { theme: t } }), theme);
    await dash.evaluate(() => (window as unknown as B).hirora.invoke('settings:get')).then(() => undefined);
    await dash.reload();
    await expect(dash.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(dash.getByRole('heading', { name: /Your meetings/ })).toBeVisible();
    await snap(dash, `08-home-${theme}.png`);
  }
  await dash.evaluate(() => (window as unknown as B).hirora.invoke('settings:update', { appearance: { theme: 'system' } }));
  await dash.reload();
});

test('a typed question before setup fails gracefully and says how to fix it', async () => {
  const dash = await windowByTitle('Doing');
  // Independent of earlier tests: a restarted worker starts on the onboarding dialog.
  const skip = dash.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Meetings' }).click();
  await dash.getByLabel('Type a question').fill('What is a hash map?');
  await dash.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(dash.getByText(/not set up yet/).first()).toBeVisible({ timeout: 10_000 });
  await snap(dash, '05-not-set-up-error.png');
});

test('renderer has no access to Node, secrets or raw IPC', async () => {
  const dash = await windowByTitle('Doing');
  const probe = await dash.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridgeKeys: Object.keys((window as unknown as { hirora: object }).hirora).sort(),
  }));
  expect(probe.require).toBe('undefined');
  expect(probe.process).toBe('undefined');
  expect(probe.bridgeKeys).toEqual(['invoke', 'onLive', 'pathForFile', 'platform']);
  const blocked = await dash.evaluate(async () => {
    try {
      await (window as unknown as { hirora: { invoke: (c: string) => Promise<unknown> } }).hirora.invoke('shell:exec');
      return 'allowed';
    } catch (e) {
      return String(e);
    }
  });
  expect(blocked).toContain('Blocked IPC channel');
  // Remote content is blocked for UI windows.
  const remote = await dash.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return 'loaded';
    } catch {
      return 'blocked';
    }
  });
  expect(remote).toBe('blocked');
});

test('overlay window exists, toggles and paints transcript area', async () => {
  const dash = await windowByTitle('Doing');
  await dash.evaluate(() => (window as unknown as { hirora: { invoke: (c: string) => Promise<unknown> } }).hirora.invoke('overlay:toggle'));
  const overlay = await windowByTitle('Doing Overlay');
  await expect(overlay.getByLabel('Ask a question')).toBeVisible();
  await expect(overlay.getByText(/isn’t set up on this PC yet/)).toBeVisible();
  await snap(overlay, '06-overlay.png');
  // Overlay is created always-on-top and skip-taskbar; focusable only when the user clicks.
  const flags = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), onTop: w.isAlwaysOnTop(), visible: w.isVisible() })),
  );
  expect(flags.find((f) => f.title === 'Doing Overlay')?.onTop).toBe(true);
});

test('consent is required before capture starts', async () => {
  const overlay = await windowByTitle('Doing Overlay');
  await overlay.getByRole('button', { name: 'Start listening' }).click();
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await expect(overlay.getByText(/everyone in the conversation has agreed/)).toBeVisible();
  await snap(overlay, '07-consent.png');
  await overlay.getByRole('button', { name: 'Cancel' }).click();
  const state = await overlay.evaluate(async () => (await (window as unknown as { hirora: { invoke: (c: string) => Promise<{ snapshot: { session: string } }> } }).hirora.invoke('session:snapshot')).snapshot.session);
  expect(state).toBe('idle');
});

test('no keys, provider or cloud settings on disk', async () => {
  const logDir = join(userData, 'logs');
  const files = existsSync(logDir) ? readdirSync(logDir).map((f) => join(logDir, f)) : [];
  files.push(join(userData, 'settings.json'));
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    expect(text).not.toMatch(/AIza[0-9A-Za-z\-_]{35}/);
    expect(text).not.toMatch(/xai-[A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  }
  const settings = readFileSync(join(userData, 'settings.json'), 'utf8');
  expect(settings).not.toMatch(/providers|primaryProvider|vercel|budget/);
  expect(existsSync(join(userData, 'secrets.json'))).toBe(false);
});
