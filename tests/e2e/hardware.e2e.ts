/**
 * REAL-HARDWARE end-to-end checks on the machine running the tests:
 *  - WASAPI mic + loopback capture through the full app pipeline (helper → main → levels)
 *  - Capture Compatibility Check (desktopCapturer + GDI) with content protection
 *  - Global hotkey → overlay paint latency using real OS keyboard input
 * Results are written to test-results/hardware-report.json. Nothing here is simulated;
 * if a capability is unavailable on the machine the test records that instead.
 */
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'apps', 'desktop');
// DOING_E2E_EXE=<path to installed Doing.exe> runs the suite against an installed build.
const INSTALLED = process.env.DOING_E2E_EXE;
const ELECTRON = INSTALLED ?? join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
// Keep painting even when other windows cover the app (Chromium's native occlusion
// tracking otherwise stops frames, and page.screenshot() waits forever).
const PAINT_FLAGS = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];
const LAUNCH_ARGS = INSTALLED ? PAINT_FLAGS : [...PAINT_FLAGS, APP_DIR];
const OUT = join(ROOT, 'test-results');
const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };

let app: ElectronApplication;
let dash: Page;
let userData: string;

type Bridge = { doing: { invoke: (c: string, p?: unknown) => Promise<unknown> } };
const call = <T>(page: Page, channel: string, payload?: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as Bridge).doing.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

function toneWav(path: string, seconds: number) {
  const rate = 48000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.25 * 32767 * Math.min(1, i / 2000, (n - i) / 2000)), 44 + i * 2);
  writeFileSync(path, buf);
}

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  userData = mkdtempSync(join(tmpdir(), 'doing-hw-'));
  app = await electron.launch({ executablePath: ELECTRON, args: LAUNCH_ARGS, env: { ...process.env, DOING_USER_DATA: userData, DOING_ENGINE_WHISPER_PORT: '8189', DOING_ENGINE_OLLAMA_PORT: '11445' } });
  for (let i = 0; i < 60 && !dash; i++) {
    for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
    if (!dash) await new Promise((r) => setTimeout(r, 250));
  }
  await call(dash, 'settings:update', { onboardingComplete: true });
});

test.afterAll(async () => {
  writeFileSync(join(OUT, 'hardware-report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => undefined);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('native helper enumerates real devices', async () => {
  const d = await call<{ capture: Array<{ name: string; isDefault: boolean }>; render: Array<{ name: string; isDefault: boolean }>; error: string | null }>(dash, 'audio:devices');
  report.devices = { capture: d.capture.map((x) => `${x.isDefault ? '*' : ' '}${x.name}`), render: d.render.map((x) => `${x.isDefault ? '*' : ' '}${x.name}`), error: d.error };
  expect(d.error).toBeNull();
  expect(d.capture.length + d.render.length).toBeGreaterThan(0);
});

// Uses the engine installed on this PC (on its own ports, so a running Doing is untouched).
test('live session captures mic + system audio and transcribes on this PC (a tone yields no text)', async () => {
  const engine = await call<{ ready: boolean }>(dash, 'engine:status');
  test.skip(!engine.ready, 'the engine is not installed on this PC (press Set up in the app first)');
  const wav = join(tmpdir(), `vc-hw-tone-${process.pid}.wav`);
  toneWav(wav, 4);
  await call(dash, 'session:start', { consent: true });
  const player = spawn('powershell.exe', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${wav}').PlaySync()`], { stdio: 'ignore' });
  const maxLevels: Record<string, number> = { mic: -100, system: -100 };
  const t0 = Date.now();
  while (Date.now() - t0 < 4500) {
    const levels = await dash.evaluate(() => new Promise<Record<string, number>>((res) => {
      const off = (window as unknown as { doing: { onLive: (cb: (e: { type: string; levels?: Record<string, number> }) => void) => () => void } }).doing.onLive((e) => {
        if (e.type === 'levels' && e.levels) {
          off();
          res(e.levels);
        }
      });
      setTimeout(() => res({}), 500);
    }));
    for (const [k, v] of Object.entries(levels)) maxLevels[k] = Math.max(maxLevels[k] ?? -100, v);
  }
  player.kill();
  await new Promise((r) => setTimeout(r, 2200)); // let a helper stats event arrive
  const snap = await call<{ snapshot: { session: string; sources: Array<{ source: string; state: string; deviceName: string | null; sttState: string; sttError: string | null; framesSent: number; framesDropped: number; framesPadded: number }> } }>(dash, 'session:snapshot');
  await call(dash, 'session:stop');
  try {
    rmSync(wav);
  } catch {
    /* ignore */
  }
  report.liveCapture = { maxLevelsDbfs: maxLevels, sources: snap.snapshot.sources };
  const sys = snap.snapshot.sources.find((s) => s.source === 'system')!;
  const mic = snap.snapshot.sources.find((s) => s.source === 'mic')!;
  expect(snap.snapshot.session).toBe('listening');
  expect(sys.state).toBe('streaming');
  expect(mic.state).toBe('streaming');
  expect(maxLevels.system).toBeGreaterThan(-30); // the tone was captured via loopback
  expect(sys.framesDropped).toBe(0);
  // Transcription is running on this PC; a pure tone produces no transcript (never fake text).
  expect(sys.sttState).toBe('open');
  expect(sys.sttError).toBeNull();
});

test('capture compatibility check measures real capture paths', async () => {
  const results = await call<Array<{ method: string; result: string; detail: string; osRelease: string; electron: string }>>(dash, 'capture:runCheck');
  report.captureCheck = results;
  expect(results.length).toBeGreaterThanOrEqual(2);
  for (const r of results) expect(['hidden', 'visible', 'not_verified', 'error', 'unsupported']).toContain(r.result);
});

test('global hotkey → overlay paint latency (real OS key events)', async () => {
  await call(dash, 'perf:clear');
  const iterations = 24;
  const ps = `Add-Type -AssemblyName System.Windows.Forms; for ($i=0; $i -lt ${iterations}; $i++) { [System.Windows.Forms.SendKeys]::SendWait('^+ '); Start-Sleep -Milliseconds 350 }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 800));
  const summary = await call<{ rows: Array<{ stage: string; count: number; p50: number; p95: number; max: number }> }>(dash, 'perf:summary');
  const row = summary.rows.find((r) => r.stage === 'hotkey_to_paint');
  report.hotkeyToPaint = row ?? 'no samples (hotkey may be taken by another app)';
  expect(row?.count ?? 0).toBeGreaterThan(5);
});

test('local benchmarks run on real code paths', async () => {
  const bench = await call<Array<{ label: string; p50: number; p95: number }>>(dash, 'perf:runLocalBench');
  report.localBench = bench;
  expect(bench.length).toBe(4);
  const cold = await call<{ rows: Array<{ stage: string; p50: number }> }>(dash, 'perf:summary');
  report.perfSummary = cold.rows;
});
