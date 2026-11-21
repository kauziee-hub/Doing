/**
 * LIVE Hirora Cloud test — what a friend's fresh install does: brand-new profile,
 * only the shared access code entered, no API keys, no GPU.
 *
 * Opt-in: HIRORA_CLOUD_CODE=<access code> (and optionally HIRORA_CLOUD_URL). Real
 * network calls to the deployed relay → Groq. Results go to test-results/cloud-report.json.
 */
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CODE = process.env.HIRORA_CLOUD_CODE;
test.skip(!CODE, 'Set HIRORA_CLOUD_CODE to run the live Hirora Cloud suite');

const ROOT = resolve(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'apps', 'desktop');
const INSTALLED = process.env.HIRORA_E2E_EXE;
const ELECTRON = INSTALLED ?? join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PAINT_FLAGS = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];
const LAUNCH_ARGS = INSTALLED ? PAINT_FLAGS : [...PAINT_FLAGS, APP_DIR];
const OUT = join(ROOT, 'test-results');
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), server: process.env.HIRORA_CLOUD_URL ?? 'default' };

let app: ElectronApplication;
let dash: Page;
let userData: string;
let freshSttProvider = '';
let connect: { ok: boolean; latencyMs: number; models: Array<{ id: string }>; error: string | null } | null = null;

type Bridge = { hirora: { invoke: (c: string, p?: unknown) => Promise<unknown>; onLive: (cb: (e: unknown) => void) => () => void } };
const call = <T>(channel: string, payload?: unknown) =>
  dash.evaluate(([c, p]) => (window as unknown as Bridge).hirora.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

interface Answer {
  requestId: string;
  status: string;
  text: string;
  error: string | null;
  provider: string | null;
  model: string | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  questionSource: string;
}

async function rec() {
  return (await dash.evaluate(() => (window as unknown as { __rec: unknown }).__rec)) as {
    answers: Record<string, Answer>;
    segments: Record<string, { text: string; final: boolean; isQuestion: boolean; source: string }>;
  };
}

async function waitAnswer(id: string, ms = 60_000): Promise<Answer> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const a = (await rec()).answers[id];
    if (a && ['done', 'error', 'cancelled'].includes(a.status)) return a;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`answer ${id} did not finish`);
}

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  userData = mkdtempSync(join(tmpdir(), 'hirora-cloud-'));
  app = await electron.launch({ executablePath: ELECTRON, args: LAUNCH_ARGS, env: { ...process.env, HIRORA_USER_DATA: userData, HIRORA_MIGRATE_FROM: '' } });
  for (let i = 0; i < 80 && !dash; i++) {
    for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Hirora') dash = w;
    if (!dash) await new Promise((r) => setTimeout(r, 250));
  }
  await dash.evaluate(() => {
    const w = window as unknown as Bridge & { __rec: { answers: Record<string, unknown>; segments: Record<string, unknown> } };
    w.__rec = { answers: {}, segments: {} };
    w.hirora.onLive((e) => {
      const ev = e as { type: string; answer?: { requestId: string }; segment?: { id: string } };
      if (ev.type === 'answer' && ev.answer) w.__rec.answers[ev.answer.requestId] = ev.answer;
      if (ev.type === 'transcript' && ev.segment) w.__rec.segments[ev.segment.id] = ev.segment;
    });
  });
  const fresh = await call<{ stt: { provider: string } }>('settings:get');
  freshSttProvider = fresh.stt.provider;
  const patch: Record<string, unknown> = { onboardingComplete: true };
  if (process.env.HIRORA_CLOUD_URL) patch.providers = { cloud: { baseUrl: process.env.HIRORA_CLOUD_URL } };
  await call('settings:update', patch);
  // Every worker connects, so a retried test never starts from a profile without the code.
  await call('secrets:set', { provider: 'cloud', key: CODE });
  connect = await call('providers:test', { provider: 'cloud' });
});

test.afterAll(async () => {
  writeFileSync(join(OUT, 'cloud-report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => undefined);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* db may be locked briefly */
  }
});

test('a fresh install connects with only the access code', async () => {
  expect(freshSttProvider).toBe('cloud-whisper'); // new installs transcribe through Hirora Cloud
  const t = connect!;
  const s = await call<{ answer: { primaryProvider: string | null }; providers: { cloud: { model: string } } }>('settings:get');
  report.connect = { ok: t.ok, latencyMs: t.latencyMs, models: t.models.map((m) => m.id), primary: s.answer.primaryProvider, model: s.providers.cloud.model, error: t.error };
  expect(t.ok, t.error ?? '').toBe(true);
  expect(s.answer.primaryProvider).toBe('cloud');
  expect(s.providers.cloud.model).toBe('openai/gpt-oss-20b');
});

test('typed questions stream real answers through the cloud', async () => {
  const qs = [
    ['In two bullet points: what is the difference between a process and a thread?', 'general'],
    ['Write a Python function that reverses a linked list.', 'coding'],
    ['What is a hash map, in one sentence?', 'general'],
    ['Explain the CAP theorem briefly.', 'explain'],
    ['Tell me about a time you handled a production outage.', 'interview_practice'],
  ] as const;
  const runs = [];
  for (const [text, mode] of qs) {
    const { requestId } = await call<{ requestId: string }>('ask:text', { text, mode });
    const a = await waitAnswer(requestId);
    runs.push({ mode, status: a.status, model: a.model, firstTokenMs: a.firstTokenMs, totalMs: a.totalMs, chars: a.text.length, hasCode: /```/.test(a.text), error: a.error, sample: a.text.slice(0, 160) });
  }
  report.typed = runs;
  for (const r of runs) expect(r.status, r.error ?? '').toBe('done');
  expect(runs[1]!.hasCode).toBe(true); // the coding answer contains a fenced code block
});

test('speaker audio → loopback → cloud Whisper → auto-answer', async () => {
  const sentence = 'Can you explain the difference between a process and a thread?';
  await call('settings:update', { audio: { micEnabled: false, systemEnabled: true }, answer: { autoAnswer: true, autoAnswerSources: ['system'], mode: 'general' } });
  await call('session:start', { consent: true });
  for (let i = 0; i < 50; i++) {
    const s = await call<{ snapshot: { sources: Array<{ source: string; sttState: string }> } }>('session:snapshot');
    const st = s.snapshot.sources.find((x) => x.source === 'system')?.sttState;
    if (st === 'open' || st === 'error') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const speakStart = Date.now();
  await new Promise<void>((res, rej) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${sentence}'); $s.Dispose()`], { timeout: 30_000 }, (e) => (e ? rej(e) : res())),
  );
  const speakEnd = Date.now();
  let seg: { text: string; isQuestion: boolean } | undefined;
  let answer: Answer | undefined;
  let segAt: number | null = null;
  for (let i = 0; i < 300 && !(answer && ['done', 'error'].includes(answer.status)); i++) {
    const r = await rec();
    const found = Object.values(r.segments).filter((x) => x.source === 'system' && x.final).pop();
    if (found && !seg) segAt = Date.now();
    seg = found ?? seg;
    const sys = Object.values(r.answers).filter((a) => a.questionSource === 'system');
    answer = sys.find((a) => a.status === 'done') ?? sys.pop();
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const snap = await call<{ snapshot: { sources: Array<{ source: string; sttState: string; sttError: string | null; framesDropped: number }> } }>('session:snapshot');
  await call('session:stop');
  const perf = await call<{ rows: Array<{ stage: string; provider: string | null; count: number; p50: number; p95: number }> }>('perf:summary');
  report.liveAudio = {
    fixture: 'Windows SAPI voice → default output → WASAPI loopback',
    reference: sentence,
    speechSeconds: (speakEnd - speakStart) / 1000,
    transcriptAfterSpeechEndMs: segAt ? segAt - speakEnd : null,
    transcript: seg ?? null,
    answer: answer ? { status: answer.status, firstTokenMs: answer.firstTokenMs, text: answer.text.slice(0, 400), error: answer.error } : null,
    sources: snap.snapshot.sources,
    perf: perf.rows,
  };
  expect(snap.snapshot.sources.find((s) => s.source === 'system')?.sttError ?? null).toBeNull();
  expect(seg?.text ?? '').toMatch(/process/i);
  expect(seg?.text ?? '').toMatch(/thread/i);
  expect(answer?.status, answer?.error ?? 'no answer').toBe('done');
});

test('a wrong access code is rejected clearly', async () => {
  await call('secrets:set', { provider: 'cloud', key: 'hirora-WRONG-CODE-0000' });
  const r = await call<{ ok: boolean; error: string | null; errorCode: string | null }>('providers:test', { provider: 'cloud' });
  report.wrongCode = { ok: r.ok, errorCode: r.errorCode, error: r.error };
  expect(r.ok).toBe(false);
  expect(r.errorCode).toBe('invalid_key');
});
