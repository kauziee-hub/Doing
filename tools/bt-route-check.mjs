#!/usr/bin/env node
// Diagnoses where Windows actually plays audio when a Bluetooth headset's hands-free
// mic is open: runs one helper per render endpoint (loopback), opens the configured
// mic in the first helper, speaks a sentence with SAPI to the default output, and
// prints the loudest level each endpoint carried. Prints no audio or transcript.
//   node tools/bt-route-check.mjs [micDeviceId|default]
import { spawn, execFile } from 'node:child_process';
import { resolve } from 'node:path';

const helperPath = resolve('native/windows-audio/target/release/doing-audio.exe');
const micId = process.argv[2] && process.argv[2] !== 'default' ? process.argv[2] : null;

function helper() {
  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = Buffer.alloc(0);
  let next = 1;
  const pending = new Map();
  const peak = { mic: -100, system: -100 };
  let measuring = false;
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 24) {
      const len = buf.readUInt32LE(20);
      if (buf.length < 24 + len) break;
      const kind = buf[3];
      const source = buf[4] === 1 ? 'mic' : buf[4] === 2 ? 'system' : 'other';
      const payload = buf.subarray(24, 24 + len);
      buf = buf.subarray(24 + len);
      if (kind === 1 && measuring) {
        let s = 0;
        const n = payload.length / 2;
        for (let i = 0; i < n; i++) { const v = payload.readInt16LE(i * 2) / 32768; s += v * v; }
        const db = n ? 20 * Math.log10(Math.sqrt(s / n) || 1e-9) : -100;
        if (source in peak) peak[source] = Math.max(peak[source], db);
      } else if (kind === 2) {
        const ev = JSON.parse(payload.toString('utf8'));
        if (ev.type === 'response' && pending.has(ev.id)) { pending.get(ev.id)(ev); pending.delete(ev.id); }
      }
    }
  });
  const send = (cmd) => new Promise((res) => { const id = next++; pending.set(id, res); child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n'); });
  return { child, send, peak, setMeasuring: (v) => (measuring = v) };
}

const probe = helper();
const devices = (await probe.send({ cmd: 'list_devices' })).data;
const renders = devices.render;
const helpers = renders.map(() => helper());
const all = helper();
if (micId !== undefined) await helpers[0].send({ cmd: 'start', source: 'mic', deviceId: micId ?? '' });
for (let i = 0; i < renders.length; i++) await helpers[i].send({ cmd: 'start', source: 'system', deviceId: renders[i].id });
await all.send({ cmd: 'start', source: 'system', deviceId: 'all' });
await new Promise((r) => setTimeout(r, 2500)); // let a Bluetooth profile switch settle
helpers.forEach((h) => h.setMeasuring(true));
all.setMeasuring(true);
await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('Tell me about a project you are proud of.'); $s.Dispose()"], () => res()));
await new Promise((r) => setTimeout(r, 500));
const defaultRender = renders.find((r) => r.isDefault)?.name;
console.log(JSON.stringify({
  micOpened: micId === null ? 'Windows default' : (devices.capture.find((c) => c.id === micId)?.name ?? micId),
  defaultOutput: defaultRender,
  loudestLevelPerOutputDbfs: Object.fromEntries(renders.map((r, i) => [r.name, Math.round(helpers[i].peak.system)])),
  allOutputsMixDbfs: Math.round(all.peak.system),
  micPeakDbfs: Math.round(helpers[0].peak.mic),
}, null, 1));
for (const h of [probe, all, ...helpers]) { h.child.stdin.write(JSON.stringify({ id: 999, cmd: 'shutdown' }) + '\n'); }
setTimeout(() => process.exit(0), 300);
