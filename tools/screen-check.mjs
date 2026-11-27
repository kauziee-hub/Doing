#!/usr/bin/env node
// Screen-reading check with the real engine: shows a code snippet full-screen in Edge (like a
// colleague's shared screen in a call), then asks Doing about "this code" and about something
// unrelated, and reports whether the screen was used, the latency and the answer. Fresh profile.
//   node tools/screen-check.mjs [--exe <Doing.exe>]
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
// Windows doesn't let a background process take the foreground, so a window that was active
// when the check started (the terminal, a chat app) can stay in front of Edge and end up in the
// capture instead. Pin the test window above other windows (topmost) and maximise it.
const pinOnTop = (title) => {
  const ps = `Add-Type -Name W -Namespace H -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
$p = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '${title}*' } | Select-Object -First 1
if ($p) { [void][H.W]::ShowWindow($p.MainWindowHandle, 3); [void][H.W]::SetWindowPos($p.MainWindowHandle, [System.IntPtr](-1), 0, 0, 0, 0, 3); [void][H.W]::SetForegroundWindow($p.MainWindowHandle); 'pinned' } else { 'not found' }`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim() === 'pinned';
};
const TITLE = 'Doing screen check';

const CODE = `// orders-service/routes.js
const express = require('express');
const router = express.Router();

router.get('/orders', listOrders);
router.get('/orders/:id', getOrder);
router.post('/orders', createOrder);
router.delete('/orders/:id', deleteOrder);
router.post('/refunds/:orderId', issueRefund);

module.exports = router;`;

const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.setContent(`<!doctype html><title>${TITLE}</title><body style="margin:0;background:#1e1e1e;color:#d4d4d4;font:28px/1.5 Consolas,monospace;padding:48px"><pre>${CODE.replace(/</g, '&lt;')}</pre></body>`);
await sleep(800);

const ud = mkdtempSync(join(tmpdir(), 'doing-screen-'));
const app = await electron.launch({ executablePath: exe, args: launchArgs, env: { ...process.env, DOING_USER_DATA: ud } });
let dash;
for (let i = 0; i < 80 && !dash; i++) {
  for (const w of app.windows()) if ((await w.title().catch(() => '')) === 'Doing') dash = w;
  if (!dash) await sleep(250);
}
const call = (c, p) => dash.evaluate(([c, p]) => window.doing.invoke(c, p), [c, p]);
await call('settings:update', { onboardingComplete: true });
const engine = await call('engine:status');
await dash.evaluate(() => {
  window.__ans = {};
  window.doing.onLive((e) => {
    if (e.type === 'answer') window.__ans[e.answer.requestId] = e.answer;
  });
});
// Keep Edge in front, like a call app showing a shared screen (Doing's windows are left out of captures anyway).
await page.bringToFront();
const edgeOnTop = pinOnTop(TITLE);
await sleep(500);
const ask = async (text) => {
  const r = await call('ask:text', { text });
  for (let i = 0; i < 480; i++) {
    const a = (await dash.evaluate(() => window.__ans))[r.requestId];
    if (a && ['done', 'error', 'cancelled'].includes(a.status)) return a;
    await sleep(250);
  }
  return null;
};
await ask('Say OK.'); // waits for the engine to load, like the first question of a call
await call('perf:clear');
const out = [];
for (const q of ['Can you establish an RBAC protocol in this?', 'What is RBAC?', 'Which of these routes should only an admin be allowed to call?', 'Write a function that checks whether a string has balanced brackets.']) {
  const a = await ask(q);
  out.push({ q, status: a?.status, usedScreen: !!a?.usedScreen, firstTokenMs: a?.firstTokenMs, totalMs: a?.totalMs, hasCode: /```/.test(a?.text ?? ''), sections: ['Answer', 'Approach', 'Code', 'Complexity', 'Tests'].filter((h) => a?.text?.includes(`**${h}**`)), mentions: ['issueRefund', 'deleteOrder', '/refunds', '/orders/:id', 'router'].filter((w) => a?.text?.includes(w)), text: (a?.text ?? '').replace(/\s+/g, ' ').slice(0, 400) });
}
// Same question with no code on screen: the answer should say it can't see any routes, not invent them.
// Clear the transcript and answer memory first, or the model can repeat its earlier answer about the routes.
await call('session:clearTranscript');
await page.setContent(`<!doctype html><title>${TITLE}</title><body style="margin:0;background:#fff;color:#222;font:26px/1.6 Georgia,serif;padding:64px"><h1>Team offsite</h1><p>Lunch is at 12:30 in the main hall. Please bring a laptop charger and a notebook. The afternoon session covers the hiring plan for next quarter.</p></body>`);
await page.bringToFront();
await sleep(600);
{
  const q = 'Which of these routes should only an admin be allowed to call?';
  const a = await ask(q);
  out.push({ q: `${q} [no code on screen]`, status: a?.status, usedScreen: !!a?.usedScreen, firstTokenMs: a?.firstTokenMs, saysNotVisible: /can(no|')t see|don'?t see|not (visible|shown)|no routes|isn'?t (any|a) (route|code)/i.test(a?.text ?? ''), inventedRoutes: (a?.text ?? '').match(/`?\/[a-z][\w/:-]*`?/gi) ?? [], text: (a?.text ?? '').replace(/\s+/g, ' ').slice(0, 400) });
}
const perf = await call('perf:summary');
await app.close();
await browser.close();
rmSync(ud, { recursive: true, force: true });
console.log(JSON.stringify({ engine: { tier: engine.tier, answers: engine.answerModel }, edgeOnTop, results: out, screenCapture: (perf.recent ?? []).filter((r) => r.stage === 'screen_capture').map((r) => `${Math.round(r.ms)} ms ${r.label}`) }, null, 1));
