/**
 * End-to-end tests against the REAL built Electron app (pnpm build first).
 * Each run uses a brand-new temporary profile, i.e. a fresh install with no keys.
 * No provider is mocked: tests that need keys are not in this file.
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
  app = await electron.launch({
    executablePath: ELECTRON,
    args: LAUNCH_ARGS,
    env: { ...process.env, HIRORA_USER_DATA: userData, NODE_ENV: 'production' },
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* windows may still hold the db for a moment */
  }
});

test('fresh install opens dashboard with onboarding and no keys', async () => {
  const dash = await windowByTitle('Hirora');
  await expect(dash.getByRole('dialog')).toBeVisible();
  await expect(dash.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await snap(dash, '01-onboarding-welcome.png');
  await dash.getByRole('button', { name: 'Next' }).click();
  await expect(dash.getByRole('heading', { name: 'Provider key' })).toBeVisible();
  await expect(dash.getByText('no key').first()).toBeVisible();
  await snap(dash, '02-onboarding-keys.png');
  await dash.getByRole('button', { name: 'Skip setup' }).click();
  await expect(dash.getByRole('heading', { name: /Ready when/ })).toBeVisible();
  await expect(dash.getByText('Add an API key')).toBeVisible();
  await snap(dash, '03-home-no-keys.png');
});

test('every page is navigable without keys', async () => {
  const dash = await windowByTitle('Hirora');
  const titles: Record<string, RegExp> = { Knowledge: /knowledge/i, Profiles: /profiles/i, History: /history/i, Performance: /performance/i, Settings: /settings/i, 'About & privacy': /privacy/i, Home: /ready when/i };
  for (const [page, title] of Object.entries(titles)) {
    const btn = dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: page, exact: true });
    await btn.click();
    await expect(btn).toHaveAttribute('aria-current', 'page');
    await expect(dash.locator('h1.dash-page-title')).toHaveText(title);
  }
  await dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  for (const tab of ['Providers', 'Transcription', 'Audio', 'Answers', 'Overlay & capture', 'Hotkeys', 'Privacy & data', 'Budget']) {
    await dash.getByRole('tab', { name: tab }).click();
    await expect(dash.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
  await dash.getByRole('tab', { name: 'Audio' }).click();
  // Real device enumeration through the native helper.
  await expect(dash.locator('select').first()).toBeVisible();
  await snap(dash, '04-settings-audio.png');
});

test('light and dark themes render', async () => {
  const dash = await windowByTitle('Hirora');
  type B = { hirora: { invoke: (c: string, p?: unknown) => Promise<unknown> } };
  for (const theme of ['light', 'dark'] as const) {
    await dash.evaluate((t) => (window as unknown as B).hirora.invoke('settings:update', { appearance: { theme: t } }), theme);
    await dash.evaluate(() => (window as unknown as B).hirora.invoke('settings:get')).then(() => undefined);
    await dash.reload();
    await expect(dash.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(dash.getByRole('heading', { name: /Ready when/ })).toBeVisible();
    await snap(dash, `08-home-${theme}.png`);
  }
  await dash.evaluate(() => (window as unknown as B).hirora.invoke('settings:update', { appearance: { theme: 'system' } }));
  await dash.reload();
});

test('typed question without a key fails gracefully with an actionable error', async () => {
  const dash = await windowByTitle('Hirora');
  // Independent of earlier tests: a restarted worker starts on the onboarding dialog.
  const skip = dash.getByRole('button', { name: 'Skip setup' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Home' }).click();
  await dash.getByLabel('Type a question').fill('What is a hash map?');
  await dash.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(dash.getByText(/No answer provider with a saved key/)).toBeVisible({ timeout: 10_000 });
  await snap(dash, '05-no-key-error.png');
});

test('renderer has no access to Node, secrets or raw IPC', async () => {
  const dash = await windowByTitle('Hirora');
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
  const dash = await windowByTitle('Hirora');
  await dash.evaluate(() => (window as unknown as { hirora: { invoke: (c: string) => Promise<unknown> } }).hirora.invoke('overlay:toggle'));
  const overlay = await windowByTitle('Hirora Overlay');
  await expect(overlay.getByLabel('Ask a question')).toBeVisible();
  await expect(overlay.getByText(/No answer model configured yet/)).toBeVisible();
  await snap(overlay, '06-overlay.png');
  // Overlay is created always-on-top and skip-taskbar; focusable only when the user clicks.
  const flags = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), onTop: w.isAlwaysOnTop(), visible: w.isVisible() })),
  );
  expect(flags.find((f) => f.title === 'Hirora Overlay')?.onTop).toBe(true);
});

test('consent is required before capture starts', async () => {
  const overlay = await windowByTitle('Hirora Overlay');
  await overlay.getByRole('button', { name: 'Start listening' }).click();
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await expect(overlay.getByText(/everyone in the conversation has agreed/)).toBeVisible();
  await snap(overlay, '07-consent.png');
  await overlay.getByRole('button', { name: 'Cancel' }).click();
  const state = await overlay.evaluate(async () => (await (window as unknown as { hirora: { invoke: (c: string) => Promise<{ snapshot: { session: string } }> } }).hirora.invoke('session:snapshot')).snapshot.session);
  expect(state).toBe('idle');
});

test('no secrets or keys in logs or settings on disk', async () => {
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
});
