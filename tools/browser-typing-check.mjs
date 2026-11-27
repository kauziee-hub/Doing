#!/usr/bin/env node
// Real installed Doing + its local model + bundled companion + real Monaco editor.
// The exercise is LeetCode Two Sum, paraphrased for this local test. This is NOT the live
// LeetCode site: its security-verification page blocks the fresh automated browser.
// Download the pinned monaco-editor@0.58.0 tarball into test-results and extract it to
// test-results/monaco-0.58.0 before running. No fixture answers or planner replacements.
//   node tools/browser-typing-check.mjs --exe <installed Doing.exe>
import { chromium, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, cp, copyFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import vm from 'node:vm';

const exeIndex = process.argv.indexOf('--exe');
if (exeIndex < 0) throw new Error('Pass the installed Doing.exe with --exe');
const exe = resolve(process.argv[exeIndex + 1]);
const full = process.argv.includes('--full');
const long = process.argv.includes('--long');
const count = long ? 50 : 10;
const browserOnly = process.argv.includes('--browser-only');
const dev = process.argv.includes('--dev');
const monaco = resolve('test-results/monaco-0.58.0/package/min');
const out = resolve('test-results/browser-typing');
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'doing-real-typing-'));
let app, context, server, dash, siteVideo;
let invoke;
const events = [];
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Doing typing check — Two Sum (local test)</title>
<style>body{margin:0;background:#17191d;color:#eee;font:15px/1.6 system-ui}header{padding:12px 24px;background:#272a31}main{display:flex;height:calc(100vh - 50px)}article{width:38%;padding:24px;overflow:auto}h1{font-size:25px}a{color:#f5ba58}.editor{flex:1;padding:18px;border-left:1px solid #444}#editor{height:calc(100% - 72px);min-height:460px}code{color:#f5ba58}.badge{color:#b4d8bd;font-size:12px}</style>
</head><body><header><strong>Doing browser typing verification</strong> <span class="badge">LOCAL TEST · real Monaco · real local model</span></header>
<main><article><h1>1. Two Sum</h1><p>Practice question based on <a href="https://leetcode.com/problems/two-sum/description/">LeetCode Two Sum</a>. This page is a local test, not a LeetCode submission.</p>
<p>Implement <code>twoSum(nums, target)</code> in JavaScript. Find two different positions whose values total the target. Return their zero-based indices as an array. Every input has one valid pair. Either index order is acceptable.</p>
<p>Example: nums = [5, 8, 2, 13], target = 10 → [1, 2].</p><p>Use a linear-time approach. The supplied function signature must be preserved.</p><p>Typing-only test: enter the complete solution in the editor. Do not run or submit to a website.</p></article>
<section class="editor"><h2>JavaScript</h2><div id="editor" aria-label="JavaScript solution editor"></div></section></main>
<script src="/vs/loader.js"></script><script>require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],function(){window.editor=monaco.editor.create(document.getElementById('editor'),{value:'/** @param {number[]} nums @param {number} target @return {number[]} */\\nvar twoSum = function(nums, target) {\\n    \\n};',language:'javascript',theme:'vs-dark',automaticLayout:true,minimap:{enabled:false},fontSize:15,accessibilitySupport:'on'});window.editorInputEvents=0;window.editor.onDidChangeModelContent(()=>window.editorInputEvents++);});</script></body></html>`;

const practice = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ten local practice questions</title><style>body{font:18px/1.7 system-ui;max-width:760px;margin:70px auto}label{display:block;padding:8px}button{padding:12px 25px;margin-top:24px}</style></head><body><h1>Local browser task verification</h1><section id="question"></section><script>
const questions = [
 ['What is 6 times 7?', ['36','42','48'], '42'],
 ['What is 9 plus 8?', ['17','18','19'], '17'],
 ['Which language runs natively in web browsers?', ['JavaScript','Rust','Python'], 'JavaScript'],
 ['How many minutes are in an hour?', ['30','60','90'], '60'],
 ['What is 15 minus 6?', ['8','9','10'], '9'],
 ['Which data structure follows first in first out?', ['Stack','Queue','Set'], 'Queue'],
 ['What is 3 squared?', ['6','9','12'], '9'],
 ['Which HTTP method usually retrieves a resource?', ['GET','DELETE','PATCH'], 'GET'],
 ['What is 100 divided by 4?', ['20','25','40'], '25'],
 ['Which type represents true or false?', ['String','Boolean','Number'], 'Boolean']
];let index=0;window.submissions=[];const root=document.getElementById('question');function render(){if(index===questions.length){root.innerHTML='<h2>Results: all 10 completed</h2><p>Score '+window.submissions.filter(s=>s.correct).length+'/10</p>';return;}const q=questions[index];root.innerHTML='<h2>Question '+(index+1)+' of 10</h2><p>'+q[0]+'</p>'+q[1].map(v=>'<label><input type="radio" name="answer" value="'+v+'">'+v+'</label>').join('')+'<button id="submit">Submit and next</button>';document.getElementById('submit').onclick=()=>{const value=root.querySelector('input:checked')?.value;if(!value)return;window.submissions.push({question:q[0],value,correct:value===q[2]});index++;render();};}render();</script></body></html>`;
const longPractice = `<!doctype html><title>Fifty questions local test</title><style>body{font:17px system-ui;margin:20px auto;max-width:800px}section{height:350px;padding:25px}section:nth-of-type(5n){height:1100px}label{display:block;padding:7px}</style><h1>50 practice questions</h1>${Array.from({length:50},(_,i)=>`<section><h2>Question ${i+1}</h2><p>What is ${i+3} plus 7?</p>${[i+9,i+10,i+11].map(v=>`<label><input type="radio" name="q${i}" value="${v}" onchange="window.answers[${i}]={question:${i+1},value:${v},correct:${v===i+10}};window.submissions=Object.values(window.answers)">${v}</label>`).join('')}<button onclick="window.checkedAnswers++">Check Answer</button></section>`).join('')}<h2>End of all 50 questions</h2><script>window.answers={};window.submissions=[];window.checkedAnswers=0;</script>`;
let localReport = null,
  practiceReport = null;
try {
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/practice') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(long ? longPractice : practice);
        return;
      }
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = resolve(monaco, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(monaco + sep)) {
        res.writeHead(403).end();
        return;
      }
      res.setHeader(
        'Content-Type',
        { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream',
      );
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = await electron.launch({
    executablePath: exe,
    args: [
      ...(dev ? [resolve('apps/desktop')] : []),
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
    ],
    env: { ...process.env, DOING_USER_DATA: join(temp, 'profile'), DOING_BROWSER_PORT: '0' },
  });
  for (let i = 0; i < 100 && !dash; i++) {
    for (const win of app.windows()) if ((await win.title().catch(() => '')) === 'Doing') dash = win;
    if (!dash) await new Promise((r) => setTimeout(r, 200));
  }
  if (!dash) throw new Error('Installed app did not open');
  invoke = (channel, payload) => dash.evaluate(([c, p]) => window.doing.invoke(c, p), [channel, payload]);
  await dash.getByRole('dialog').getByRole('button', { name: 'Skip', exact: true }).click();
  const info = await invoke('app:info');
  console.log(JSON.stringify({ stage: 'installed-app', version: info.version, packaged: info.packaged }));
  const engine = await invoke('engine:status');
  if (!engine.ready) throw new Error('Installed app did not detect the existing local engine');
  if (full && !browserOnly) {
    const allowed = join(temp, 'allowed-files');
    await mkdir(allowed);
    await writeFile(join(allowed, 'notes.txt'), 'Original note: keep this line.\n');
    const unrelated = join(temp, 'unrelated.txt');
    await writeFile(unrelated, 'Untouched');
    // Only the native picker is supplied a test folder; model calls and file operations are real.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, allowed);
    await dash.getByRole('button', { name: 'Allow a folder', exact: true }).click();
    const ask = async (text) => {
      await dash.getByLabel('Message Doing', { exact: true }).fill(text);
      await dash.getByRole('button', { name: 'Send message', exact: true }).click();
      const start = performance.now();
      let status;
      for (let i = 0; i < 240; i++) {
        status = await invoke('local:status');
        if (!status.busy && status.messages.at(-1)?.role === 'assistant') return { status, ms: Math.round(performance.now() - start) };
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('File task did not finish: ' + JSON.stringify(status));
    };
    const create = await ask(
      'Create plan.md containing a Markdown heading Weekly plan and exactly three tasks: review notes, write a draft, and send the draft. Save it in the allowed folder.',
    );
    const created = await readFile(join(allowed, 'plan.md'), 'utf8');
    if (!/Weekly plan/i.test(created) || !create.status.changes.some((c) => c.path === 'plan.md'))
      throw new Error('Model did not create requested plan');
    const edit = await ask('Read notes.txt and append one new line: Next step: review tomorrow. Preserve the original line.');
    const edited = await readFile(join(allowed, 'notes.txt'), 'utf8');
    if (!edited.includes('Original note: keep this line.') || !edited.includes('Next step: review tomorrow.'))
      throw new Error('Model failed to preserve and edit notes');
    await invoke('local:undo');
    const restored = await readFile(join(allowed, 'notes.txt'), 'utf8');
    if (restored !== 'Original note: keep this line.\n') throw new Error('Undo did not restore original notes');
    await mkdir(join(allowed, 'draft/nested'), { recursive: true });
    await mkdir(join(allowed, 'archive'));
    await writeFile(join(allowed, 'draft/nested/payload.bin'), Buffer.from([0,255,12]));
    const move = await ask('Move the entire draft folder into archive and rename it finished. Keep everything inside it.');
    if (!(await readFile(join(allowed, 'archive/finished/nested/payload.bin'))).equals(Buffer.from([0,255,12])))
      throw new Error('Folder move did not preserve nested binary content');
    await invoke('local:undo');
    if (!(await readFile(join(allowed, 'draft/nested/payload.bin'))).equals(Buffer.from([0,255,12])))
      throw new Error('Folder undo did not restore nested content');
    const trashName = 'Doing deletion test ' + Date.now();
    await mkdir(join(allowed, trashName));
    await writeFile(join(allowed, trashName, 'fixture.txt'), 'Only a temporary Doing test fixture.');
    await app.evaluate(({shell})=>{
      const original=shell.trashItem.bind(shell);
      globalThis.doingTrashCalls=[];
      shell.trashItem=async(path)=>{await original(path);globalThis.doingTrashCalls.push(path);};
    });
    const deletion=await ask('Delete the folder "'+trashName+'".');
    const remains=await lstat(join(allowed,trashName)).then(()=>true,()=>false);
    const nativeTrashCalls=await app.evaluate(()=>globalThis.doingTrashCalls.length);
    if(remains || nativeTrashCalls!==1 || !deletion.status.messages.at(-1)?.text.includes('Moved to Recycle Bin:')) throw new Error('Native deletion did not match confirmed completion');
    await invoke('local:revoke');
    const revoked = await invoke('local:status');
    if (revoked.folder !== null || revoked.messages.length || (await readFile(unrelated, 'utf8')) !== 'Untouched')
      throw new Error('Revocation or scope check failed');
    localReport = {
      model: engine.answerModel,
      created,
      edited,
      undoRestored: true,
      folderMovedAndUndone: true,
      nativeRecycleBinVerified: true,
      nativeTrashCalls,
      moveMs: move.ms,
      revoked: true,
      unrelatedUnchanged: true,
      createMs: create.ms,
      editMs: edit.ms,
    };
    await dash.screenshot({ path: join(out, 'assistant.png') });
    console.log(JSON.stringify({ stage: 'local-files', ...localReport }));
  }
  await dash.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Browser assistant', exact: true }).click();
  const enable = dash.getByRole('button', { name: 'Enable browser connection', exact: true });
  if (await enable.isVisible()) await enable.click();
  const connection = await invoke('browser:status');
  const extension = join(temp, 'extension');
  await cp(
    dev ? resolve('apps/desktop/resources/browser-extension') : join(resolve(exe, '..'), 'resources', 'browser-extension'),
    extension,
    { recursive: true },
  );
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Test-only permission replaces the extension-toolbar activeTab gesture in headless Chromium.
  manifest.host_permissions.push(`${origin}/*`);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temp, 'browser'), {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1440, height: 940 },
    recordVideo: { dir: join(out, 'video'), size: { width: 1440, height: 940 } },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const site = await context.newPage();
  siteVideo = site.video();
  await site.goto(origin);
  await site.waitForFunction(() => !!window.editor);
  await site.screenshot({ path: join(out, 'before.png') });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await popup.waitForFunction(() => document.getElementById('connection').textContent === 'No tab shared.');
  await site.bringToFront();
  const pairing = popup.evaluate(({ port }) => globalThis.chrome.runtime.sendMessage({ type: 'connect', port }), { port: connection.port });
  await dash
    .getByRole('region', { name: 'Browser connection approval' })
    .getByRole('button', { name: 'Allow connection & remember' })
    .click();
  const paired = await pairing;
  if (paired.error) throw new Error(paired.error);
  await popup.getByText('Allowed pages are ready.', { exact: true }).waitFor();
  await popup
    .getByLabel('Message Doing')
    .fill('What must I implement on this page? State the exact function signature and the return value.');
  await popup.getByRole('button', { name: 'Send message', exact: true }).click();
  await popup.locator('.message.assistant').first().waitFor({ timeout: 100000 });
  const pageAnswer = await popup.locator('.message.assistant').last().innerText();
  if (!/twoSum/.test(pageAnswer) || !/nums/.test(pageAnswer) || !/target/.test(pageAnswer))
    throw new Error('Page answer did not read the function signature');
  if ((await site.evaluate(() => window.editorInputEvents)) !== 0) throw new Error('Read-only question changed the editor');
  console.log(JSON.stringify({ stage: 'page-question', answer: pageAnswer, inputEvents: 0 }));
  await popup
    .getByLabel('Message Doing')
    .fill(
      'Now solve it and type the complete JavaScript solution into its code editor, preserving the twoSum(nums, target) signature. Once the solution is visibly entered, finish. Do not click any links, Run, or Submit.',
    );
  const start = performance.now();
  await popup.getByRole('button', { name: 'Send message', exact: true }).click();
  let final;
  for (let i = 0; i < 1200; i++) {
    const s = await invoke('browser:status');
    const last = s.message;
    if (events.at(-1)?.message !== last) {
      events.push({ ms: Math.round(performance.now() - start), phase: s.phase, steps: s.steps, message: last });
      console.log(JSON.stringify(events.at(-1)));
    }
    if (s.messages?.length >= 4 && ['done', 'error', 'stopped', 'review'].includes(s.phase)) {
      final = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const result = await site.evaluate(() => ({ code: window.editor.getValue(), inputEvents: window.editorInputEvents }));
  await writeFile(join(out, 'typed-solution.js'), result.code);
  await site.screenshot({ path: join(out, 'after.png') });
  await popup.setViewportSize({ width: 400, height: 940 });
  await popup.screenshot({ path: join(out, 'chat.png') });
  const cases = [
    { nums: [5, 8, 2, 13], target: 10 },
    { nums: [3, 3], target: 6 },
    { nums: [-4, 2, 9, 1], target: 5 },
    { nums: [0, 8, 0], target: 0 },
    { nums: [4, 12, 7, 1], target: 19 },
  ];
  const tests = cases.map(({ nums, target }) => {
    try {
      const sandbox = { nums: [...nums], target };
      const indices = vm.runInNewContext(`${result.code}\n;twoSum(nums, target)`, sandbox, { timeout: 1000 });
      const ok =
        Array.isArray(indices) &&
        indices.length === 2 &&
        indices.every((v) => Number.isInteger(v) && v >= 0 && v < nums.length) &&
        indices[0] !== indices[1] &&
        nums[indices[0]] + nums[indices[1]] === target;
      return { nums, target, indices, ok };
    } catch (e) {
      return { nums, target, ok: false, error: e.message };
    }
  });
  if (final?.phase !== 'done' || !result.inputEvents || !tests.every((t) => t.ok))
    throw new Error('Code entry or independent solution tests failed.');
  if (full) {
    await site.goto(origin + '/practice');
    await popup.getByRole('button', { name: 'New chat', exact: true }).click();
    await popup.getByText('Allowed pages are ready.', { exact: true }).waitFor();
    // Wait for the desktop to receive the new page, rather than a stale panel poll.
    let practiceReady = false;
    for (let i = 0; i < 80; i++) {
      const state = await invoke('browser:status');
      if (state.pageReady && state.tab?.url === origin + '/practice') { practiceReady = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!practiceReady) throw new Error('Practice page did not reach the desktop observation');
    await popup
      .getByLabel('Message Doing')
      .fill(
        long ? 'Answer all 50 practice questions. Select the correct option for each question, scroll down when needed, and continue until all 50 have answers. Do not submit or click Check Answer.' : 'Answer all ten practice questions correctly. Select the correct option, click Submit and next on each question, and continue until the final results page. Submit all remaining pages without asking again.',
      );
    await popup.getByRole('button', { name: 'Send message', exact: true }).click();
    const began = performance.now();
    let current;
    let lastProgress = '';
    for (let i = 0; i < 1200; i++) {
      current = await invoke('browser:status');
      if (current.message !== lastProgress) {
        lastProgress = current.message;
        console.log(JSON.stringify({ stage: 'practice-progress', steps: current.steps, phase: current.phase, message: current.message }));
      }
      if (['done', 'error', 'review', 'stopped'].includes(current.phase) && current.messages?.at(-1)?.role === 'assistant') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const submissions = await site.evaluate(() => window.submissions);
    practiceReport = {
      log: current?.log,
      task: current?.task,
      phase: current?.phase,
      steps: current?.steps,
      message: current?.messages?.at(-1)?.text,
      submissions,
      durationMs: Math.round(performance.now() - began),
    };
    await site.screenshot({ path: join(out, 'ten-results.png') });
    await popup.screenshot({ path: join(out, 'ten-chat.png') });
    await writeFile(join(out, 'full-workflow.json'), JSON.stringify({ localReport, practiceReport }, null, 2));
    console.log(JSON.stringify({ stage: 'ten-real-model', ...practiceReport }));
    if (long && await site.evaluate(() => window.checkedAnswers) !== 0) throw new Error('Do-not-submit was violated');
    if (current?.phase !== 'done' || submissions.length !== count || (!long && !submissions.every((s) => s.correct)))
      throw new Error('Real-model ten-question task failed');
  }
  const report = {
    version: info.version,
    packaged: info.packaged,
    source: 'LeetCode Two Sum, paraphrased local test with real Monaco 0.58.0; live site showed security verification',
    model: engine.answerModel,
    pageAnswer,
    readOnlyInputEvents: 0,
    phase: final?.phase,
    steps: final?.steps,
    inputEvents: result.inputEvents,
    durationMs: Math.round(performance.now() - start),
    tests,
    events,
    localReport,
    practiceReport,
  };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: 'result', ...report }));
  if (final?.phase !== 'done' || !result.inputEvents || !tests.every((t) => t.ok))
    throw new Error('Typing or solution verification failed. See test-results/browser-typing/report.json');
} finally {
  if (invoke) await invoke('browser:disable').catch(() => {});
  await context?.close();
  if (siteVideo) await copyFile(await siteVideo.path(), join(out, 'typing.webm'));
  await app?.close();
  server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep + 'doing-real-typing-')) await rm(temp, { recursive: true, force: true });
}
