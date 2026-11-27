#!/usr/bin/env node
// Coding-round check with the real engine: shows a FIXTURE coding problem (made up, so the model
// can't recall it) full-screen in Edge, like a problem the interviewer shares or one opened from
// a link, then:
//   1. presses Ctrl+Shift+O on the keyboard, then the overlay's screen button (`ask:screenNow`), nothing typed;
//   2. asks the spoken-style "Can you solve this problem?" and "Here is the problem, take your time";
//   3. asks "Tell me about yourself", which must not use the screen.
// Reports whether the screen was used, whether the answer read the problem (title and exact
// signature), the latency and the start of the answer. Fresh profile; covers the screen for about
// a minute, so run it when the PC isn't in use.
//   node tools/coding-screen-check.mjs [--exe <Doing.exe>]
import { _electron as electron, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const exeIdx = args.indexOf('--exe');
const APP = resolve('apps/desktop');
const exe = exeIdx >= 0 ? args[exeIdx + 1] : join(APP, 'node_modules/electron/dist/electron.exe');
const launchArgs = ['--disable-features=CalculateNativeWinOcclusion', ...(exeIdx >= 0 ? [] : [APP])];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TITLE = 'Doing coding check';
// Windows keeps the window that was active in front; pin the test page topmost and maximised.
const pinOnTop = (title) => {
  const ps = `Add-Type -Name W -Namespace H -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
$p = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '${title}*' } | Select-Object -First 1
if ($p) { [void][H.W]::ShowWindow($p.MainWindowHandle, 3); [void][H.W]::SetWindowPos($p.MainWindowHandle, [System.IntPtr](-1), 0, 0, 0, 0, 3); [void][H.W]::SetForegroundWindow($p.MainWindowHandle); 'pinned' } else { 'not found' }`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim() === 'pinned';
};

// FIXTURE: a made-up problem laid out like an online judge (problem left, editor right).
const PAGE = `<!doctype html><title>${TITLE}</title><style>
body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#1a1a1a;color:#eee;font-size:14px}
.top{height:44px;background:#282828;display:flex;align-items:center;padding:0 16px;gap:18px;color:#bbb;font-size:13px}
.wrap{display:flex;height:calc(100vh - 44px)}.left{width:44%;padding:18px 22px;border-right:1px solid #333}.right{flex:1;display:flex;flex-direction:column}
h1{font-size:20px;margin:6px 0 10px}code{background:#2b2b2b;border-radius:4px;padding:1px 4px;font-family:Consolas,monospace;font-size:13px}
pre{background:#232323;padding:10px 12px;border-radius:6px;font-family:Consolas,monospace;font-size:13px;line-height:1.5}
.ed{flex:1;background:#1e1e1e;font-family:Consolas,monospace;font-size:14px;line-height:1.55;padding:10px 14px;color:#d4d4d4}
</style><div class="top"><b style="color:#ffa116">CodeArena</b><span>Problem List</span><span style="margin-left:auto">Python3</span><span>Run</span><span>Submit</span></div>
<div class="wrap"><div class="left"><h1>2471. Longest Calm Stretch</h1>
<p>You are given an integer array <code>readings</code> from a temperature sensor and an integer <code>k</code>. A stretch is a contiguous, non-empty part of <code>readings</code>. A stretch is <b>calm</b> if the difference between its largest and smallest reading is at most <code>k</code>.</p>
<p>Return <i>the length of the longest calm stretch</i>.</p>
<p><b>Example 1:</b></p><pre>Input: readings = [8, 2, 4, 7], k = 4
Output: 2</pre><p><b>Example 2:</b></p><pre>Input: readings = [10, 1, 2, 4, 7, 2], k = 5
Output: 4</pre>
<p><b>Constraints:</b> <code>1 &lt;= readings.length &lt;= 10^5</code>, <code>0 &lt;= k &lt;= 10^9</code></p></div>
<div class="right"><div class="ed">class Solution:<br>&nbsp;&nbsp;&nbsp;&nbsp;def longestCalmStretch(self, readings: List[int], k: int) -&gt; int:<br><br></div></div></div>`;

const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.setContent(PAGE);
await sleep(800);

const ud = mkdtempSync(join(tmpdir(), 'doing-coding-'));
const app = await electron.launch({ executablePath: exe, args: launchArgs, env: { ...process.env, DOING_USER_DATA: ud } });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
  if (!dash) await sleep(250);
}
const call = (c, p) => dash.evaluate(([c, p]) => window.doing.invoke(c, p), [c, p]);
await call('settings:update', { onboardingComplete: true });
await dash.evaluate(() => {
  window.__ans = {};
  window.doing.onLive((e) => {
    if (e.type === 'answer') window.__ans[e.answer.requestId] = e.answer;
  });
});
await page.bringToFront();
const edgeOnTop = pinOnTop(TITLE);
await sleep(500);
const wait = async (requestId) => {
  for (let i = 0; i < 480; i++) {
    const a = (await dash.evaluate(() => window.__ans))[requestId];
    if (a && ['done', 'error', 'cancelled'].includes(a.status)) return a;
    await sleep(250);
  }
  return null;
};
const report = (q, a) => ({
  q,
  status: a?.status,
  usedScreen: !!a?.usedScreen,
  firstTokenMs: a?.firstTokenMs,
  totalMs: a?.totalMs,
  readTitle: /Longest Calm Stretch/i.test(a?.text ?? ''),
  readSignature: /longestCalmStretch\s*\(\s*self\s*,\s*readings/.test(a?.text ?? ''),
  hasCode: /```/.test(a?.text ?? ''),
  error: a?.error ?? null,
  text: (a?.text ?? '').replace(/\s+/g, ' ').slice(0, 500),
});
await wait((await call('ask:text', { text: 'Say OK.' })).requestId); // engine warm-up
const out = [];
{
  // The real global shortcut, pressed through Windows while the problem page is in front.
  const before = new Set(Object.keys(await dash.evaluate(() => window.__ans)));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+o')"], { timeout: 20_000 });
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    id = Object.keys(await dash.evaluate(() => window.__ans)).find((k) => !before.has(k)) ?? null;
    if (!id) await sleep(250);
  }
  out.push(report('[Ctrl+Shift+O pressed on the keyboard]', id ? await wait(id) : { status: 'no answer started (shortcut taken by another app?)' }));
}
{
  const r = await call('ask:screenNow');
  out.push(report('[Answer from the screen: Ctrl+Shift+O, nothing typed]', r.requestId ? await wait(r.requestId) : { status: 'error', error: r.error }));
}
for (const q of ['Can you solve this problem?', 'Here is the problem, take your time', 'Tell me about yourself']) {
  out.push(report(q, await wait((await call('ask:text', { text: q })).requestId)));
}
const perf = await call('perf:summary');
await app.close();
await browser.close();
rmSync(ud, { recursive: true, force: true });
console.log(JSON.stringify({ edgeOnTop, results: out, screenCapture: (perf.recent ?? []).filter((r) => r.stage === 'screen_capture').map((r) => `${Math.round(r.ms)} ms ${r.label}`) }, null, 1));
