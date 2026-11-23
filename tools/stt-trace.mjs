#!/usr/bin/env node
// Spoken trace of the speech path, question by question, on a COPY of a profile: speaks each
// question through the default output with Windows SAPI (labelled TTS fixture) and records when it
// played, the system-audio level, every live transcript update (interim and final), the speech
// timings (perf, no text) and when the answer started. Answer text is not printed.
//   node tools/stt-trace.mjs [profileDir] [--exe <Hirora.exe>] [--live on|off] [--detector sava|energy]
// Plays sound: run it on AC power, when speaking aloud is fine.
import { _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : def);
const profile = args[0] && !args[0].startsWith('--') ? args[0] : join(process.env.APPDATA, 'Hirora');
const exeArg = opt('--exe', null);
const live = opt('--live', 'on') === 'on';
const detector = opt('--detector', 'sava');
const APP = resolve('apps/desktop');
const exe = exeArg ?? join(APP, 'node_modules/electron/dist/electron.exe');
const launchArgs = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', ...(exeArg ? [] : [APP])];
const QUESTIONS = ['Please introduce yourself.', 'Can you tell me about a challenging project you worked on?', 'What is the difference between a process and a thread?'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ud = join(mkdtempSync(join(tmpdir(), 'hirora-trace-')), 'Hirora');
cpSync(profile, ud, { recursive: true, filter: (s) => s === profile || (dirname(s) === profile && statSync(s).isFile() && !/lockfile$/.test(s)) });
const app = await electron.launch({ executablePath: exe, args: launchArgs, env: { ...process.env, HIRORA_USER_DATA: ud, HIRORA_STT_DEBUG: '1' } });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Hirora') dash = w;
  if (!dash) await sleep(250);
}
const call = (c, p) => dash.evaluate(([c, p]) => window.hirora.invoke(c, p), [c, p]);
await call('settings:update', { privacy: { saveHistory: false }, overlay: { contentProtection: true }, stt: { streamingTranscription: live, sttTurnDetector: detector } });
const settings = await call('settings:get');
for (let i = 0; i < 240 && !(await call('engine:status')).ready; i++) await sleep(250);
await dash.evaluate(() => {
  window.__rec = { answers: {}, segs: [], levels: [] };
  window.hirora.onLive((e) => {
    const t = Date.now();
    if (e.type === 'answer') window.__rec.answers[e.answer.requestId] = { ...e.answer, text: undefined, seenAt: t };
    if (e.type === 'transcript') window.__rec.segs.push({ t, id: e.segment.id, source: e.segment.source, final: e.segment.final, text: e.segment.text, committed: e.segment.committedText ?? null, tentative: e.segment.tentativeText ?? null });
    if (e.type === 'levels' && e.levels.system !== undefined) window.__rec.levels.push([t, Math.round(e.levels.system)]);
  });
});
await call('perf:clear');
await call('overlay:toggle');
const started = await call('session:start', { consent: true });
for (let i = 0; i < 60; i++) {
  const sn = (await call('session:snapshot')).snapshot;
  if (sn.sources.some((x) => x.source === 'system' && x.sttState === 'open')) break;
  if (i === 59) console.error('system audio never opened:', JSON.stringify({ state: started?.session ?? started, sources: sn.sources }));
  await sleep(250);
}
for (let i = 0; i < 360; i++) {
  const p = await call('perf:summary');
  if (p.rows.some((r) => r.stage === 'provider_preconnect' && r.provider === 'ollama') && (p.recent ?? []).some((r) => r.label === 'prompt-preread')) break;
  await sleep(500);
}
await call('perf:clear');
await sleep(1500);
const played = [];
const perfRows = new Map();
const collect = async () => {
  for (const r of (await call('perf:summary')).recent ?? []) perfRows.set(`${r.at}|${r.stage}|${r.ms}|${r.label}`, r);
};
for (const q of QUESTIONS) {
  const out = await new Promise((res) =>
    execFile('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $a=[DateTimeOffset]::Now.ToUnixTimeMilliseconds(); $s.Speak('${q.replace(/'/g, "''")}'); $b=[DateTimeOffset]::Now.ToUnixTimeMilliseconds(); $s.Dispose(); Write-Output "$a $b"`], (_e, stdout) => res(stdout)),
  );
  const [a, b] = String(out).trim().split(/\s+/).map(Number);
  played.push({ q, start: a, end: b });
  await sleep(6000);
  await collect();
}
const snap = await call('session:snapshot');
await call('session:stop');
const rec = await dash.evaluate(() => window.__rec);
const perf = await call('perf:summary');
await app.close();
// Live-path debug lines (HIRORA_STT_DEBUG=1): numbers per 40 ms block, no audio or text.
const debug = [];
try {
  const { readFileSync, readdirSync } = await import('node:fs');
  for (const f of readdirSync(join(ud, 'logs'))) {
    for (const l of readFileSync(join(ud, 'logs', f), 'utf8').split(/\r?\n/)) {
      const m = l.match(/stt-debug.*"line":"([^"]+)"/);
      if (m) debug.push(m[1]);
    }
  }
} catch {
  /* no log */
}
rmSync(join(ud, '..'), { recursive: true, force: true });

for (const r of perf.recent ?? []) perfRows.set(`${r.at}|${r.stage}|${r.ms}|${r.label}`, r);
const recent = [...perfRows.values()].sort((x, y) => x.at - y.at);
const livePath = recent.some((r) => r.stage === 'stt_decode');
console.log(`path: ${livePath ? 'LIVE' : '0.3.1'} (setting streamingTranscription=${settings.stt.streamingTranscription}, detector=${settings.stt.sttTurnDetector}); system: ${snap.snapshot.sources.find((x) => x.source === 'system')?.deviceName}`);
for (let i = 0; i < played.length; i++) {
  const p = played[i];
  const until = played[i + 1]?.start ?? Infinity;
  const rel = (t) => `${t - p.start >= 0 ? '+' : ''}${t - p.start}`;
  console.log(`\nQ${i + 1} "${p.q}"  played ${rel(p.start)}..${rel(p.end)} ms`);
  const lv = rec.levels.filter(([t]) => t >= p.start - 300 && t < until);
  const above = (db) => lv.find(([, l]) => l > db);
  console.log(`  level: first > -58 dBFS ${above(-58) ? rel(above(-58)[0]) : '-'}, > -50 ${above(-50) ? rel(above(-50)[0]) : '-'}, > -40 ${above(-40) ? rel(above(-40)[0]) : '-'}, peak ${Math.max(-100, ...lv.map(([, l]) => l))} dBFS`);
  for (const s of rec.segs.filter((x) => x.source === 'system' && x.t >= p.start - 300 && x.t < until)) {
    console.log(`  ${rel(s.t).padStart(6)} ${s.final ? 'FINAL' : 'live '} ${JSON.stringify(s.text)}${s.committed !== null && !s.final ? `  [fixed: ${JSON.stringify(s.committed)}]` : ''}`);
  }
  for (const r of recent.filter((x) => x.at >= p.start - 300 && x.at < until && /turn_end_detect|stt_final_wait|speech_end_to_final|stt_decode|stt_window|question_to_first_token|final_to_question|question_gate/.test(x.stage))) {
    console.log(`  ${rel(r.at).padStart(6)} perf ${r.stage} ${Math.round(r.ms)} ms ${r.label ?? ''}`);
  }
  if (process.env.TRACE_BLOCKS) for (const l of debug) { const [src, at, ...rest] = l.split(' '); const t = Number(at); if (src === 'system' && t >= p.start + 300 && t < p.start + 1400) console.log(`  ${rel(t).padStart(6)} block ${rest.join(' ')}`); }
  for (const a of Object.values(rec.answers).filter((x) => x.seenAt >= p.start - 300 && x.seenAt < until)) {
    console.log(`  answer ${a.status} firstTokenMs=${a.firstTokenMs} for ${JSON.stringify(a.question)}`);
  }
}
