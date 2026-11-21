/**
 * LIVE end-to-end tests: real provider calls with the user's saved key(s).
 *
 * Opt-in: set HIRORA_LIVE_PROFILE to a Hirora profile folder that already has
 * keys saved through Settings (normally %APPDATA%\Hirora). The folder is COPIED
 * to a temp directory (same Windows user, so DPAPI can decrypt) and the copy is
 * deleted afterwards — the real profile is never modified.
 * The copy is handed to the app as a legacy (pre-rename VeyraCue) profile via
 * HIRORA_MIGRATE_FROM, so the run also proves migration keeps saved keys usable.
 * HIRORA_LIVE_OLLAMA_MODEL=<pulled model> adds local-model answer tests (Ollama on 127.0.0.1).
 * Results (no keys, no audio) are written to test-results/live-report.json.
 */
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURE_RESUME_PAGES, buildPdf } from '../fixtures/builders';

const PROFILE = process.env.HIRORA_LIVE_PROFILE;
test.skip(!PROFILE, 'Set HIRORA_LIVE_PROFILE to run live provider tests');

const ROOT = resolve(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'apps', 'desktop');
const INSTALLED = process.env.HIRORA_E2E_EXE;
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
let legacy: string;
const OLLAMA_MODEL = process.env.HIRORA_LIVE_OLLAMA_MODEL;

type Bridge = { hirora: { invoke: (c: string, p?: unknown) => Promise<unknown>; onLive: (cb: (e: unknown) => void) => () => void } };
const call = <T>(channel: string, payload?: unknown) =>
  dash.evaluate(([c, p]) => (window as unknown as Bridge).hirora.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

interface Answer {
  requestId: string;
  status: string;
  text: string;
  error: string | null;
  errorCode: string | null;
  provider: string | null;
  model: string | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  sources: Array<{ label: string; documentTitle: string; page: number | null; evidence: string }>;
  questionSource: string;
}

/** Collects live events in the page so tests can await answers/transcripts. */
async function installRecorder(): Promise<void> {
  await dash.evaluate(() => {
    const w = window as unknown as Bridge & { __rec: { answers: Record<string, unknown>; segments: Record<string, unknown> } };
    w.__rec = { answers: {}, segments: {} };
    w.hirora.onLive((e) => {
      const ev = e as { type: string; answer?: { requestId: string }; segment?: { id: string } };
      if (ev.type === 'answer' && ev.answer) w.__rec.answers[ev.answer.requestId] = ev.answer;
      if (ev.type === 'transcript' && ev.segment) w.__rec.segments[ev.segment.id] = ev.segment;
    });
  });
}

async function waitAnswer(requestId: string, timeoutMs = 90_000): Promise<Answer> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const a = (await dash.evaluate((id) => (window as unknown as { __rec: { answers: Record<string, unknown> } }).__rec.answers[id], requestId)) as Answer | undefined;
    if (a && ['done', 'error', 'cancelled'].includes(a.status)) return a;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`answer ${requestId} did not finish`);
}

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  legacy = mkdtempSync(join(tmpdir(), 'hirora-legacy-'));
  cpSync(PROFILE!, legacy, { recursive: true, filter: (src) => !/[\\/](logs|Cache|Code Cache|GPUCache|DawnCache|blob_storage)([\\/]|$)/.test(src) });
  // Fresh, empty userData: the app itself migrates the copied profile into it on launch.
  userData = join(mkdtempSync(join(tmpdir(), 'hirora-live-')), 'Hirora');
  app = await electron.launch({ executablePath: ELECTRON, args: LAUNCH_ARGS, env: { ...process.env, HIRORA_USER_DATA: userData, HIRORA_MIGRATE_FROM: legacy } });
  for (let i = 0; i < 80 && !dash; i++) {
    for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Hirora') dash = w;
    if (!dash) await new Promise((r) => setTimeout(r, 250));
  }
  // Provider TTFT under load was ~8–9 s when measured (Nov 2026): use the app's current default budget.
  await call('settings:update', { onboardingComplete: true, privacy: { saveHistory: false }, answer: { firstTokenTimeoutMs: 20_000 } });
  await installRecorder();
});

test.afterAll(async () => {
  // Playwright restarts the worker after a failure; merge so earlier results from this run survive.
  const file = join(OUT, 'live-report.json');
  const readPrev = (): Record<string, unknown> => {
    try {
      const p = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      return Date.now() - Date.parse(String(p.generatedAt)) > 30 * 60_000 ? {} : p;
    } catch {
      return {};
    }
  };
  const prev = readPrev();
  writeFileSync(file, JSON.stringify({ ...prev, ...report, generatedAt: prev.generatedAt ?? report.generatedAt }, null, 2));
  await app?.close().catch(() => undefined);
  try {
    rmSync(join(userData, '..'), { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  } catch {
    /* db may be locked briefly */
  }
});

test('the pre-rename profile migrated and its saved key still decrypts', async () => {
  const info = await call<{ userDataPath: string }>('app:info');
  const secrets = await call<{ providers: Record<string, { hasKey: boolean }>; encryptionAvailable: boolean }>('secrets:status');
  report.migration = {
    userDataIsFresh: info.userDataPath === userData,
    keysPresent: Object.entries(secrets.providers).filter(([, v]) => v.hasKey).map(([k]) => k),
    hasHiroraDb: existsSync(join(userData, 'hirora.db')),
    legacyDbLeftInTarget: existsSync(join(userData, 'veyracue.db')),
  };
  expect(info.userDataPath).toBe(userData);
  expect(secrets.encryptionAvailable).toBe(true);
  expect(secrets.providers.gemini?.hasKey).toBe(true);
  expect(existsSync(join(userData, 'hirora.db'))).toBe(true);
  expect(existsSync(join(userData, 'veyracue.db'))).toBe(false);
  expect(existsSync(join(userData, '.migrated-from-veyracue'))).toBe(true);
  // A real authenticated call proves the migrated DPAPI-wrapped key decrypts.
  const t = await call<{ ok: boolean; error: string | null }>('providers:test', { provider: 'gemini' });
  expect(t.ok, t.error ?? '').toBe(true);
});

test('typed coding question streams a real answer with a code block', async () => {
  const { requestId } = await call<{ requestId: string }>('ask:text', {
    text: 'Write a Python function that returns the length of the longest substring without repeating characters.',
    mode: 'coding',
  });
  const a = await waitAnswer(requestId);
  report.coding = { status: a.status, provider: a.provider, model: a.model, firstTokenMs: a.firstTokenMs, totalMs: a.totalMs, chars: a.text.length, hasCodeFence: /```/.test(a.text), error: a.error };
  expect(a.status, a.error ?? '').toBe('done');
  expect(a.text).toMatch(/```/);
  expect(a.text).toMatch(/def\s+\w+\(/);
  expect(a.firstTokenMs).not.toBeNull();
});

test('resume fact is retrieved with a source; a missing fact is not invented', async () => {
  const pdfPath = join(userData, 'fixture-resume.pdf');
  writeFileSync(pdfPath, buildPdf(FIXTURE_RESUME_PAGES));
  const ing = await call<Array<{ ok: boolean; chunks: number }>>('knowledge:ingestPaths', { kind: 'resume', paths: [pdfPath] });
  expect(ing[0]!.ok).toBe(true);

  const q1 = await call<{ requestId: string }>('ask:text', { text: 'Tell me about your Kafka migration and its measurable impact.', mode: 'interview_practice' });
  const a1 = await waitAnswer(q1.requestId);
  const q2 = await call<{ requestId: string }>('ask:text', { text: 'What was your exact GPA and which honours society were you in?', mode: 'interview_practice' });
  const a2 = await waitAnswer(q2.requestId);
  report.grounding = {
    present: { status: a1.status, sources: a1.sources, mentions15min: /15\s*min/i.test(a1.text), mentions6h: /6\s*hours?/i.test(a1.text), firstTokenMs: a1.firstTokenMs, text: a1.text.slice(0, 900) },
    missing: { status: a2.status, sources: a2.sources.map((s) => s.documentTitle), text: a2.text.slice(0, 900) },
  };
  expect(a1.status, a1.error ?? '').toBe('done');
  expect(a1.sources.some((s) => s.documentTitle.includes('fixture-resume') && s.page === 1 && s.evidence === 'my_facts')).toBe(true);
  expect(/15\s*min/i.test(a1.text) || /6\s*hours?/i.test(a1.text)).toBe(true);
  expect(a2.status, a2.error ?? '').toBe('done');
  // The model must flag the gap instead of inventing a GPA.
  expect(a2.text).toMatch(/not in your materials|not (mentioned|listed|included|provided)|no (gpa|information)|isn't (in|listed)|\[[^\]]*(gpa|honou?rs)[^\]]*\]/i);
  expect(a2.text).not.toMatch(/\b[1-4]\.\d{1,2}\b\s*(\/\s*4|gpa)/i);
});

test('cancel stops an answer and the next question still works', async () => {
  const q1 = await call<{ requestId: string }>('ask:text', { text: 'Explain in depth how TCP congestion control works, with history.', depth: 'deep', mode: 'explain' });
  await new Promise((r) => setTimeout(r, 600));
  await call('answer:cancel');
  const a1 = await waitAnswer(q1.requestId);
  const q2 = await call<{ requestId: string }>('ask:text', { text: 'In one sentence: what is a mutex?', mode: 'general' });
  const a2 = await waitAnswer(q2.requestId);
  report.cancel = { first: a1.status, second: a2.status, secondFirstTokenMs: a2.firstTokenMs };
  expect(a1.status).toBe('cancelled');
  expect(a2.status, a2.error ?? '').toBe('done');
});

test('a wrong key fails clearly without leaking the key', async () => {
  const bogus = 'xai-' + 'Z'.repeat(60);
  await call('secrets:set', { provider: 'xai', key: bogus });
  const r = await call<{ ok: boolean; error: string | null; errorCode: string | null }>('providers:test', { provider: 'xai' });
  await call('secrets:delete', { provider: 'xai' });
  report.wrongKey = r;
  expect(r.ok).toBe(false);
  expect(['invalid_key', 'permission_denied', 'bad_request']).toContain(r.errorCode);
  expect(r.error ?? '').not.toContain(bogus);
});

async function loopbackQuestion(label: string, sentence: string, expectWords: RegExp[]): Promise<void> {
  // Start from a clean recorder so an earlier session's transcript/answer can't satisfy this one.
  await dash.evaluate(() => {
    const r = (window as unknown as { __rec: { answers: Record<string, unknown>; segments: Record<string, unknown> } }).__rec;
    r.answers = {};
    r.segments = {};
  });
  await call('settings:update', { audio: { micEnabled: false, systemEnabled: true, noiseGateDbfs: -62 }, answer: { autoAnswer: true, autoAnswerSources: ['system'], mode: 'general' } });
  const t0 = Date.now();
  await call('session:start', { consent: true });
  // Wait for the STT session to open.
  for (let i = 0; i < 50; i++) {
    const s = await call<{ snapshot: { sources: Array<{ source: string; sttState: string; sttError: string | null }> } }>('session:snapshot');
    const sys = s.snapshot.sources.find((x) => x.source === 'system');
    if (sys?.sttState === 'open' || sys?.sttState === 'error') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const sttOpenMs = Date.now() - t0;
  // Speak through the default output device with Windows' built-in SAPI voice (labelled TTS fixture).
  const speakStart = Date.now();
  await new Promise<void>((res, rej) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${sentence}'); $s.Dispose()`], { timeout: 30_000 }, (e) => (e ? rej(e) : res())),
  );
  const speakEnd = Date.now();
  let seg: { text: string; final: boolean; isQuestion: boolean; source: string } | undefined;
  let answer: Answer | undefined;
  for (let i = 0; i < 300 && !(answer && ['done', 'error'].includes(answer.status)); i++) {
    const rec = (await dash.evaluate(() => (window as unknown as { __rec: { answers: Record<string, unknown>; segments: Record<string, unknown> } }).__rec)) as {
      answers: Record<string, Answer>;
      segments: Record<string, { text: string; final: boolean; isQuestion: boolean; source: string }>;
    };
    seg = Object.values(rec.segments).filter((s) => s.source === 'system' && s.final).pop();
    const sys = Object.values(rec.answers).filter((a) => a.questionSource === 'system');
    answer = sys.find((a) => a.status === 'done') ?? sys.pop();
    await new Promise((r) => setTimeout(r, 300));
  }
  const snap = await call<{ snapshot: { sources: Array<{ source: string; sttState: string; sttError: string | null; framesDropped: number }> } }>('session:snapshot');
  await call('session:stop');
  const perf = await call<{ rows: Array<{ stage: string; provider: string | null; count: number; p50: number; p95: number }> }>('perf:summary');
  report[label] = {
    fixture: 'Windows SAPI voice played through the default output device, captured via WASAPI loopback',
    reference: sentence,
    sttOpenMs,
    speechSeconds: (speakEnd - speakStart) / 1000,
    transcript: seg ?? null,
    answer: answer ? { status: answer.status, provider: answer.provider, model: answer.model, firstTokenMs: answer.firstTokenMs, text: answer.text.slice(0, 600), error: answer.error } : null,
    sources: snap.snapshot.sources,
    perf: perf.rows,
  };
  expect(snap.snapshot.sources.find((s) => s.source === 'system')?.sttError ?? null).toBeNull();
  for (const w of expectWords) expect(seg?.text ?? '').toMatch(w);
  expect(seg?.isQuestion).toBe(true);
  expect(answer?.status, answer?.error ?? 'no answer').toBe('done');
}

test('speaker audio → WASAPI loopback → Gemini Live transcript → auto-answer', async () => {
  await loopbackQuestion('liveAudio', 'Can you explain the difference between a process and a thread?', [/process/i, /thread/i]);
});

test('local Ollama model answers typed and résumé questions (warm, measured)', async () => {
  test.skip(!OLLAMA_MODEL, 'Set HIRORA_LIVE_OLLAMA_MODEL to a pulled Ollama model');
  test.setTimeout(600_000);
  await call('settings:update', { providers: { ollama: { enabled: true, model: OLLAMA_MODEL } }, answer: { primaryProvider: 'ollama', fallbackProvider: null } });
  const t = await call<{ ok: boolean; error: string | null; models: Array<{ id: string }> }>('providers:test', { provider: 'ollama' });
  expect(t.ok, t.error ?? '').toBe(true);
  expect(t.models.map((m) => m.id)).toContain(OLLAMA_MODEL);
  // Self-contained: ingest the fixture résumé here (dedupe makes a repeat a no-op).
  const pdfPath = join(userData, 'fixture-resume.pdf');
  writeFileSync(pdfPath, buildPdf(FIXTURE_RESUME_PAGES));
  const ing = await call<Array<{ ok: boolean }>>('knowledge:ingestPaths', { kind: 'resume', paths: [pdfPath] });
  expect(ing[0]!.ok).toBe(true);
  const asks: Array<{ text: string; mode: string }> = [
    { text: 'In one sentence, what is a hash map?', mode: 'general' }, // first call also loads the model
    { text: 'Tell me about your Kafka migration and its measurable impact.', mode: 'interview_practice' },
    { text: 'What is the difference between TCP and UDP?', mode: 'general' },
    { text: 'Why do you want to work here? Keep it short.', mode: 'interview_practice' },
    { text: 'Write a Python function that reverses a linked list.', mode: 'coding' },
    { text: 'Tell me about a time you handled a production incident.', mode: 'interview_practice' },
  ];
  const runs: Array<{ q: string; status: string; provider: string | null; firstTokenMs: number | null; totalMs: number | null; chars: number; sources: number; error: string | null }> = [];
  for (const a of asks) {
    const { requestId } = await call<{ requestId: string }>('ask:text', a);
    const r = await waitAnswer(requestId, 180_000);
    runs.push({ q: a.text, status: r.status, provider: r.provider, firstTokenMs: r.firstTokenMs, totalMs: r.totalMs, chars: r.text.length, sources: r.sources.length, error: r.error });
    if (/Kafka/.test(a.text)) report.ollamaGroundedSample = r.text.slice(0, 700);
  }
  const warm = runs.slice(1).map((r) => r.firstTokenMs).filter((x): x is number => x !== null).sort((x, y) => x - y);
  report.ollamaTyped = { model: OLLAMA_MODEL, coldFirstTokenMs: runs[0]!.firstTokenMs, warmFirstTokenMs: warm, warmP50: warm[Math.floor((warm.length - 1) / 2)] ?? null, runs };
  for (const r of runs) {
    expect(r.status, r.error ?? '').toBe('done');
    expect(r.provider).toBe('ollama');
  }
  expect(runs[1]!.sources).toBeGreaterThan(0);
});

test('speaker audio → Gemini Live transcript → local Ollama auto-answer', async () => {
  test.skip(!OLLAMA_MODEL, 'Set HIRORA_LIVE_OLLAMA_MODEL to a pulled Ollama model');
  await call('settings:update', { providers: { ollama: { enabled: true, model: OLLAMA_MODEL } }, answer: { primaryProvider: 'ollama', fallbackProvider: null } });
  await loopbackQuestion('liveAudioOllama', 'What is the difference between a stack and a queue?', [/stack/i, /queue/i]);
});
