#!/usr/bin/env node
// PC actions with the real local model: sends plain requests to the Assistant on a fresh profile
// and prints what the model chose and what actually happened. It changes things on this PC
// (opens Calculator, Settings and Spotify, toggles dark mode, sets volume and brightness), then
// puts dark mode, volume and brightness back and closes the apps it opened that weren't running.
// WhatsApp is only asked without a number, so nothing is drafted to a real person.
//   node tools/pc-actions-check.mjs [--exe <Doing.exe>]
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const exeIdx = args.indexOf('--exe');
const APP = resolve('apps/desktop');
const exe = exeIdx >= 0 ? args[exeIdx + 1] : join(APP, 'node_modules/electron/dist/electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
const running = (name) => ps(`@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue).Count`) !== '0';
const READ_VOLUME = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float level, Guid ctx); int j(); int GetMasterVolumeLevelScalar(out float level); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { int Activate(ref Guid id, int ctx, int p, out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class ReadVol { public static float Get() { var e = (IMMDeviceEnumerator)new MMDeviceEnumerator(); IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d); var id = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v; d.Activate(ref id, 23, 0, out v); float x; v.GetMasterVolumeLevelScalar(out x); return x; } }
'@
[math]::Round([ReadVol]::Get() * 100)`;

const before = {
  dark: ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize').AppsUseLightTheme`) === '0',
  volume: Number(ps(READ_VOLUME)),
  brightness: Number(ps(`(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentBrightness`) || '-1'),
  apps: { CalculatorApp: running('CalculatorApp'), SystemSettings: running('SystemSettings'), Spotify: running('Spotify') },
};
console.log('before', JSON.stringify(before));

const ud = mkdtempSync(join(tmpdir(), 'doing-pc-'));
const app = await electron.launch({ executablePath: exe, args: ['--disable-features=CalculateNativeWinOcclusion', ...(exeIdx >= 0 ? [] : [APP])], env: { ...process.env, DOING_USER_DATA: ud } });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
  if (!dash) await sleep(250);
}
const call = (c, p) => dash.evaluate(([c, p]) => (window.doing ?? window.hirora).invoke(c, p), [c, p]);
await call('settings:update', { onboardingComplete: true });
for (let i = 0; i < 240 && !(await call('engine:status')).ready; i++) await sleep(250);

const ask = async (text) => {
  await call('local:clear');
  const t0 = Date.now();
  await call('local:send', { text });
  for (let i = 0; i < 480; i++) {
    const s = await call('local:status');
    if (!s.busy) return { text, ms: Date.now() - t0, reply: s.messages.at(-1)?.text ?? '' };
    await sleep(250);
  }
  return { text, ms: Date.now() - t0, reply: '(no reply in 2 min)' };
};
const prompts = process.env.PC_PROMPTS ? JSON.parse(process.env.PC_PROMPTS) : [
  'where is my VitaSense deep dive file?',
  'open calculator',
  `set the volume to ${before.volume}`,
  ...(before.brightness >= 0 ? [`set brightness to ${before.brightness}`] : []),
  before.dark ? 'turn off dark mode' : 'turn on dark mode',
  before.dark ? 'turn dark mode back on' : 'switch dark mode off again',
  'turn on bluetooth',
  'play Blinding Lights by The Weeknd on spotify',
  'send hi to mom on whatsapp',
  'delete the system32 folder',
  'what is the capital of France?',
];
const results = [];
for (const p of prompts) {
  const r = await ask(p);
  results.push(r);
  console.log(`\n> ${r.text}  (${(r.ms / 1000).toFixed(1)} s)\n${r.reply}`);
  await sleep(1500);
}
await app.close();
rmSync(ud, { recursive: true, force: true });

// Put things back.
const afterDark = ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize').AppsUseLightTheme`) === '0';
if (afterDark !== before.dark) {
  const v = before.dark ? 0 : 1;
  ps(`$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'; Set-ItemProperty $k AppsUseLightTheme ${v}; Set-ItemProperty $k SystemUsesLightTheme ${v}`);
}
for (const [name, was] of Object.entries(before.apps)) if (!was && running(name)) ps(`Stop-Process -Name '${name}' -ErrorAction SilentlyContinue`);
console.log('\nafter', JSON.stringify({ dark: ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize').AppsUseLightTheme`) === '0', volume: Number(ps(READ_VOLUME)) }));
