#!/usr/bin/env node
// Real-hardware smoke test for the native WASAPI helper (Windows only).
//
//   node tools/audio-smoke.mjs [seconds] [--no-tone] [--helper path]
//
// 1. spawns doing-audio.exe, lists devices
// 2. starts microphone + system loopback capture
// 3. plays a generated 440 Hz tone through the default output (unless --no-tone)
// 4. decodes the framed stdout protocol, reports per-source frame counts, levels,
//    dominant frequency of loopback audio, drops, padding and helper stats.
//
// Nothing is recorded to disk except the temporary tone WAV, which is deleted.
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const seconds = Number(args.find((a) => /^\d+$/.test(a)) ?? 6);
const playTone = !args.includes('--no-tone');
const helperIdx = args.indexOf('--helper');
const helper = helperIdx >= 0 ? args[helperIdx + 1] : resolve('native/windows-audio/target/release/doing-audio.exe');
if (!existsSync(helper)) {
  console.error(`helper not found: ${helper} (run pnpm native:build)`);
  process.exit(2);
}

function makeToneWav(path, freq, durS, rate = 48000) {
  const n = Math.floor(durS * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2000, (n - i) / 2000);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * env * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const perSource = { mic: newStats(), system: newStats() };
const statuses = [];
let hello = null;

function newStats() {
  return { frames: 0, padded: 0, sumSq: 0, samples: 0, peak: 0, zc: 0, prev: 0, voiced: 0, seqGaps: 0, lastSeq: -1, firstTs: null, lastTs: null };
}

function send(cmd) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
  return new Promise((res) => pending.set(id, res));
}

child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 24) {
    if (buf[0] !== 0x56 || buf[1] !== 0x43) throw new Error('bad magic');
    const len = buf.readUInt32LE(20);
    if (buf.length < 24 + len) break;
    const kind = buf[3];
    const source = buf[4] === 1 ? 'mic' : buf[4] === 2 ? 'system' : buf[4] === 3 ? 'app' : 'none';
    const flags = buf[5];
    const seq = buf.readUInt32LE(8);
    const ts = Number(buf.readBigUInt64LE(12));
    const payload = buf.subarray(24, 24 + len);
    buf = buf.subarray(24 + len);
    if (kind === 2) {
      const ev = JSON.parse(payload.toString('utf8'));
      if (ev.type === 'response' && pending.has(ev.id)) { pending.get(ev.id)(ev); pending.delete(ev.id); }
      else if (ev.type === 'hello') hello = ev;
      else if (ev.type === 'stats') { /* periodic counters; final snapshot requested below */ }
      else if (ev.type === 'status') statuses.push(ev);
      else console.log('event', ev);
    } else if (kind === 1 && perSource[source]) {
      const s = perSource[source];
      s.frames++;
      if (flags & 1) s.padded++;
      if (s.lastSeq >= 0 && seq !== s.lastSeq + 1) s.seqGaps++;
      s.lastSeq = seq;
      s.firstTs ??= ts; s.lastTs = ts;
      let frameSq = 0;
      let frameZc = 0;
      for (let i = 0; i < payload.length; i += 2) {
        const v = payload.readInt16LE(i) / 32768;
        s.sumSq += v * v; frameSq += v * v; s.samples++;
        s.peak = Math.max(s.peak, Math.abs(v));
        if ((v > 0) !== (s.prev > 0)) frameZc++;
        s.prev = v;
      }
      if (Math.sqrt(frameSq / (payload.length / 2)) > 0.01) { s.voiced++; s.zc += frameZc; }
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);
console.log('hello:', hello);
const devices = await send({ cmd: 'list_devices' });
console.log('capture devices:', devices.data.capture.map((d) => `${d.isDefault ? '*' : ' '} ${d.name}`).join('\n  '));
console.log('render devices :', devices.data.render.map((d) => `${d.isDefault ? '*' : ' '} ${d.name}`).join('\n  '));
console.log('start mic   :', (await send({ cmd: 'start', source: 'mic' })).ok);
console.log('start system:', (await send({ cmd: 'start', source: 'system' })).ok);
await sleep(800);

let tonePath = null;
let player = null;
if (playTone) {
  tonePath = join(tmpdir(), `doing-tone-${process.pid}.wav`);
  makeToneWav(tonePath, 440, Math.max(1, seconds - 2));
  player = spawn('powershell.exe', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${tonePath}').PlaySync()`], { stdio: 'ignore', windowsHide: true });
}
const t0 = Date.now();
await sleep(seconds * 1000);
const elapsed = (Date.now() - t0) / 1000 + 0.8;
const apps = await send({ cmd: 'list_audio_apps' });
const stats = await send({ cmd: 'stats' });
await send({ cmd: 'stop_all' });
await send({ cmd: 'shutdown' });
player?.kill();
if (tonePath) try { unlinkSync(tonePath); } catch { /* already gone */ }

const report = {};
for (const [name, s] of Object.entries(perSource)) {
  const rms = s.samples ? Math.sqrt(s.sumSq / s.samples) : 0;
  report[name] = {
    frames: s.frames,
    expectedFramesApprox: Math.round(elapsed * 50),
    paddedSilenceFrames: s.padded,
    seqGaps: s.seqGaps,
    rmsDbfs: rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -100,
    peak: +s.peak.toFixed(3),
    framesAboveMinus40dB: s.voiced,
    dominantFreqHzInLoudFrames: s.voiced ? Math.round(s.zc / 2 / ((s.voiced * 320) / 16000)) : 0,
    capturedSpanS: s.firstTs != null ? +((s.lastTs - s.firstTs) / 1e6).toFixed(2) : 0,
  };
}
console.log('statuses:', statuses.map((s) => `${s.source}:${s.state}${s.deviceName ? ' (' + s.deviceName + ')' : ''}${s.format ? ' ' + JSON.stringify(s.format) : ''}`));
console.log('audio apps:', apps.ok ? apps.data : apps.error);
console.log('helper stats:', JSON.stringify(stats.data));
console.log('REPORT', JSON.stringify(report, null, 2));
process.exit(0);
