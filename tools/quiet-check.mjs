#!/usr/bin/env node
// Silent latency check (no sound plays): on a COPY of a profile, waits for the engine to warm up,
// then (1) asks typed questions and records the first-token time of each answer, and (2) has
// Windows SAPI speak questions into WAV FILES and times whisper.cpp transcribing them through
// the app's own speech server. The real profile is never modified.
//   node tools/quiet-check.mjs [profileDir] [--exe <Doing.exe>] [--tier auto|gpu|cpu]
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const profile = args[0] && !args[0].startsWith('--') ? args[0] : join(process.env.APPDATA, 'Doing');
const exeIdx = args.indexOf('--exe');
const tierIdx = args.indexOf('--tier');
const APP = resolve('apps/desktop');
const exe = exeIdx >= 0 ? args[exeIdx + 1] : join(APP, 'node_modules/electron/dist/electron.exe');
const launchArgs = ['--disable-features=CalculateNativeWinOcclusion', ...(exeIdx >= 0 ? [] : [APP])];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'doing-quiet-'));
const ud = join(tmp, 'Doing');
cpSync(profile, ud, { recursive: true, filter: (s) => s === profile || (dirname(s) === profile && statSync(s).isFile() && !/lockfile$/.test(s)) });
const app = await electron.launch({ executablePath: exe, args: launchArgs, env: { ...process.env, DOING_USER_DATA: ud } });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
  if (!dash) await sleep(250);
}
const call = (c, p) => dash.evaluate(([c, p]) => window.doing.invoke(c, p), [c, p]);
await call('settings:update', { privacy: { saveHistory: false }, ...(tierIdx >= 0 ? { engine: { tier: args[tierIdx + 1] } } : {}) });
const engine = await call('engine:status');
if (!engine.ready) throw new Error(`engine not installed for the ${engine.tier} tier`);
// Warm-up: the first question waits for the engine (model load + résumé pre-read), like a real one.
await dash.evaluate(() => {
  window.__warm = null;
  window.doing.onLive((e) => {
    if (e.type === 'answer' && ['done', 'error'].includes(e.answer.status)) window.__warm = e.answer;
  });
});
const t0 = Date.now();
await call('ask:text', { text: 'Say OK.' });
for (let i = 0; i < 720 && !(await dash.evaluate(() => window.__warm)); i++) await sleep(250);
const warmAnswer = await dash.evaluate(() => window.__warm);
const warm = [`first question after launch: ${warmAnswer?.status} in ${Math.round((Date.now() - t0) / 1000)} s${warmAnswer?.error ? ` (${warmAnswer.error})` : ''}`];
await call('perf:clear');
await sleep(1000);
await dash.evaluate(() => {
  window.__ans = {};
  window.doing.onLive((e) => {
    if (e.type === 'answer') window.__ans[e.answer.requestId] = e.answer;
  });
});
const questions = [
  'Please introduce yourself.',
  'Tell me about a challenging project you worked on.',
  'What is the difference between a process and a thread?',
  'Why do companies use caching?',
  'How would you design a URL shortener?',
  'What are your strengths and weaknesses?',
];
const typed = [];
for (const q of questions) {
  const r = await call('ask:text', { text: q });
  for (let i = 0; i < 240; i++) {
    const a = (await dash.evaluate(() => window.__ans))[r.requestId];
    if (a && ['done', 'error', 'cancelled'].includes(a.status)) {
      typed.push({ q, status: a.status, firstTokenMs: a.firstTokenMs, totalMs: a.totalMs, error: a.error, text: (a.text ?? '').replace(/\s+/g, ' ').slice(0, 120) });
      break;
    }
    await sleep(250);
  }
  await sleep(500);
}
// Speech: SAPI → WAV file (silent), then the app's whisper server transcribes it.
const port = Number(process.env.DOING_ENGINE_WHISPER_PORT) || 8178;
const spoken = [];
for (const q of questions.slice(0, 4)) {
  const wav = join(tmp, `q${spoken.length}.wav`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('${q.replace(/'/g, "''")}'); $s.Dispose()`]);
  const bytes = readFileSync(wav);
  const seconds = (bytes.length - 44) / 32000;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'q.wav');
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  form.append('language', 'en');
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  const j = await res.json();
  spoken.push({ q, audioSeconds: Math.round(seconds * 10) / 10, transcribeMs: Math.round(performance.now() - t0), text: (j.text ?? '').trim() });
}
await app.close();
rmSync(tmp, { recursive: true, force: true });
const ft = typed.filter((t) => t.status === 'done').map((t) => t.firstTokenMs).sort((a, b) => a - b);
console.log(JSON.stringify({ engine: { tier: engine.tier, gpu: engine.gpu?.name ?? null, speech: engine.speechModel, answers: engine.answerModel }, warmup: warm, typed, typedFirstTokenSorted: ft, spoken }, null, 1));
