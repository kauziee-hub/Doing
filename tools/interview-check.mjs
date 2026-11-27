#!/usr/bin/env node
// End-to-end "interviewer asks, Hirora answers" check on a COPY of a real profile:
// speaks questions through the default output with Windows SAPI (labelled TTS fixture),
// listens with the profile's own mic + system settings, and reports transcripts, whether
// each question was auto-answered and the latency, using the engine on this PC. The real
// profile is never modified; the copy is deleted afterwards.
//   node tools/interview-check.mjs [profileDir] [--exe <Doing.exe>] [--system all|default|keep]
//     [--tier auto|gpu|cpu] [--script questions|chatter]
// HIRORA_ENGINE_FORCE_CPU=1 keeps the answer engine off the GPU (measures a PC without one).
import { _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const profile = args[0] && !args[0].startsWith('--') ? args[0] : join(process.env.APPDATA, 'Hirora');
const exeIdx = args.indexOf('--exe');
const sysIdx = args.indexOf('--system');
const systemMode = sysIdx >= 0 ? args[sysIdx + 1] : 'all';
const APP = resolve('apps/desktop');
const exe = exeIdx >= 0 ? args[exeIdx + 1] : join(APP, 'node_modules/electron/dist/electron.exe');
const launchArgs = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', ...(exeIdx >= 0 ? [] : [APP])];

const scriptIdx = args.indexOf('--script');
const script = scriptIdx >= 0 ? args[scriptIdx + 1] : 'questions';
/** [line, should Hirora answer it?] */
const SCRIPTS = {
  questions: [
    ['Please introduce yourself.', true],
    ['Can you tell me about a challenging project you worked on?', true],
    ['What is the difference between a process and a thread?', true],
  ],
  // Background talk mixed with real (some casual) questions.
  chatter: [
    ['Hey Rahul, come here.', false],
    ['Wait a minute.', false],
    ["What's happening?", false],
    ['so in your last internship what tech stack did you use', true],
    ['Can you hear me okay?', false],
    ['Can you explain what R B A C is and why companies use it?', true],
  ],
};
const QUESTIONS = SCRIPTS[script];

const ud = join(mkdtempSync(join(tmpdir(), 'hirora-interview-')), 'Hirora');
// Top-level files only (settings, keys, Local State, db): a running Hirora keeps its Chromium folders locked.
cpSync(profile, ud, { recursive: true, filter: (s) => s === profile || (dirname(s) === profile && statSync(s).isFile() && !/lockfile$/.test(s)) });
const app = await electron.launch({ executablePath: exe, args: launchArgs, env: { ...process.env, HIRORA_USER_DATA: ud } });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
  if (!dash) await new Promise((r) => setTimeout(r, 250));
}
const call = (c, p) => dash.evaluate(([c, p]) => window.hirora.invoke(c, p), [c, p]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const patch = { privacy: { saveHistory: false }, overlay: { contentProtection: true } };
if (systemMode === 'all') patch.audio = { systemDeviceId: 'all' };
if (systemMode === 'default') patch.audio = { systemDeviceId: null };
const tierIdx = args.indexOf('--tier');
if (tierIdx >= 0) patch.engine = { tier: args[tierIdx + 1] };
await call('settings:update', patch);
const engine = await call('engine:status');
if (!engine.ready) {
  console.error(`Engine not installed for the ${engine.tier} tier: ${engine.components.filter((c) => c.state !== 'ready').map((c) => c.label).join(', ')}`);
  await app.close();
  rmSync(join(ud, '..'), { recursive: true, force: true });
  process.exit(2);
}
const s = await call('settings:get');
await dash.evaluate(() => {
  window.__rec = { answers: {}, segments: {} };
  window.hirora.onLive((e) => {
    if (e.type === 'answer') window.__rec.answers[e.answer.requestId] = e.answer;
    if (e.type === 'transcript' && e.segment.final) window.__rec.segments[e.segment.id] = e.segment;
  });
});
await call('perf:clear');
await call('overlay:toggle'); // visible overlay, as in a real call
await call('session:start', { consent: true });
for (let i = 0; i < 60; i++) {
  const snap = await call('session:snapshot');
  const open = snap.snapshot.sources.filter((x) => x.sttState === 'open').length;
  if (open >= snap.snapshot.sources.filter((x) => x.state !== 'off').length && open > 0) break;
  await sleep(250);
}
// Wait until the answer model is loaded and has pre-read the résumé (the app does this at launch).
for (let i = 0; i < 360; i++) {
  const p = await call('perf:summary');
  // Loaded and résumé pre-read (or 60 s): what a real session has done before the first question.
  if (p.rows.some((r) => r.stage === 'provider_preconnect' && r.provider === 'ollama') && (p.recent ?? []).some((r) => r.label === 'prompt-preread')) break;
  await sleep(500);
}
const warmPerf = await call('perf:summary');
await call('perf:clear');
await sleep(1500);
for (const [q, expectAnswer] of QUESTIONS) {
  const before = Object.keys((await dash.evaluate(() => window.__rec)).answers).length;
  await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${q.replace(/'/g, "''")}'); $s.Dispose()`], () => res()));
  // An expected answer: wait for it to finish (or 25 s). Chatter: give it 7 s to (wrongly) start one.
  const t0 = Date.now();
  while (Date.now() - t0 < (expectAnswer ? 25_000 : 7_000)) {
    const rec = await dash.evaluate(() => window.__rec);
    const all = Object.values(rec.answers);
    if (expectAnswer && all.length > before && all.every((a) => ['done', 'error', 'cancelled'].includes(a.status))) break;
    await sleep(400);
  }
  await sleep(1000);
}
const snap = await call('session:snapshot');
await call('session:stop');
const rec = await dash.evaluate(() => window.__rec);
const perf = await call('perf:summary');
await app.close();
rmSync(join(ud, '..'), { recursive: true, force: true });

const segs = Object.values(rec.segments).sort((a, b) => a.startedAt - b.startedAt);
console.log(JSON.stringify({
  engine: { tier: engine.tier, gpu: engine.gpu?.name ?? null, speech: engine.speechModel, answers: engine.answerModel, forceCpu: process.env.HIRORA_ENGINE_FORCE_CPU === '1' },
  settings: { language: s.stt.language, mic: s.audio.micDeviceId ? 'pinned' : 'default', system: s.audio.systemDeviceId, autoAnswerSources: s.answer.autoAnswerSources },
  warmup: (warmPerf.recent ?? []).filter((r) => r.stage === 'provider_preconnect').map((r) => `${r.label}: ${Math.round(r.ms)} ms`),
  sources: snap.snapshot.sources.map((x) => ({ source: x.source, state: x.state, device: x.deviceName, stt: x.sttState, err: x.sttError })),
  transcript: segs.map((x) => `${x.source}${x.isQuestion ? ' [Q]' : ''}: ${x.text}`),
  answers: Object.values(rec.answers).map((a) => ({ from: a.questionSource, q: a.question?.slice(0, 70), status: a.status, provider: a.provider, model: a.model, firstTokenMs: a.firstTokenMs, error: a.error, text: (a.text ?? '').slice(0, script === 'chatter' ? 900 : 160) })),
  expected: QUESTIONS.map(([q, a]) => `${a ? 'ANSWER' : 'skip  '} ${q}`),
  gate: (perf.recent ?? []).filter((r) => r.stage === 'question_gate').map((r) => `${r.label} (${Math.round(r.ms)} ms)`),
  // Each answer as it reached the screen: time from the end of the question.
  visible: (perf.recent ?? []).filter((r) => r.stage === 'question_to_first_paint' || r.stage === 'question_to_first_token').map((r) => `${r.stage} ${r.provider ?? ''} ${r.label ?? ''}: ${Math.round(r.ms)} ms`),
  perf: perf.rows.filter((r) => /question_to_first_(token|paint)|stt_first_partial|speech_end_to_final|final_to_question/.test(r.stage)).map((r) => ({ stage: r.stage, provider: r.provider, n: r.count, p50: Math.round(r.p50), p95: Math.round(r.p95) })),
}, null, 1));
