import { fixturePort } from '../fixtures/ports';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BrowserAgent } from '../../apps/desktop/electron/main/browser/agent';

let context: BrowserContext | undefined;
let server: Server | undefined;
let agent: BrowserAgent | undefined;
let folder: string | undefined;
test.afterEach(async () => {
  agent?.disable();
  await context?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (folder && resolve(folder).startsWith(resolve(tmpdir()) + '\\hirora-browser-fixture-')) await rm(folder, { recursive: true, force: true });
});

const CODE = 'function answer() {\n  return 42;\n}\n';
// Explicit fixture: deterministic planner and a mock editor exercise browser I/O, not answer quality.
const FIXTURE = `<!doctype html><html><head><title>Browser automation FIXTURE</title></head><body>
<h1>Ten-question practice FIXTURE</h1><div id="question"></div>
<script>
let index = 0; window.submissions = []; const root = document.getElementById('question');
function render() {
  if (index === 10) { root.innerHTML = '<h2>Results: 10 completed</h2>'; return; }
  root.innerHTML = '<h2>Question ' + (index + 1) + ' of 10</h2>' + (index < 9
    ? '<p>What is six times seven?</p><label><input type="radio" name="answer" value="41">41</label><label><input type="radio" name="answer" value="42">42</label>'
    : '<p>Write a JavaScript function answer that returns 42.</p><div class="monaco-editor" aria-label="Code editor FIXTURE"><textarea aria-label="Editor input" rows="5">function answer() {}</textarea><pre class="view-line">function answer() {}</pre></div>')
    + '<button id="submit" type="button">Submit and next</button>';
  const editor = root.querySelector('textarea');
  if (editor) editor.addEventListener('input', () => root.querySelector('.view-line').textContent = editor.value);
  document.getElementById('submit').onclick = () => {
    const value = editor ? editor.value : root.querySelector('input:checked')?.value;
    if (!value) return; window.submissions.push(value); index++; render();
  };
}
render();
</script></body></html>`;

test('real Chromium extension selects MCQs, types multiline code, submits ten pages and observes results', async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(90000);
  folder = await mkdtemp(join(tmpdir(), 'hirora-browser-fixture-'));
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/reference' ? '<!doctype html><title>Group reference FIXTURE</title><h1>Reference value: 7</h1><label>Result<input id="result"></label>' : FIXTURE); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server failed');
  const origin = `http://127.0.0.1:${address.port}`;
  const extension = join(folder, 'extension');
  await cp(resolve('apps/desktop/resources/browser-extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Test-only permission replaces the toolbar activeTab gesture in headless Chromium.
  manifest.host_permissions.push(`${origin}/*`);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  agent = new BrowserAgent(async (_task, page) => {
    if (_task.startsWith('Use group FIXTURE')) {
      if (!page.title.includes('Group reference')) return { kind: 'switch', tab: page.tabs!.find((t) => t.title.includes('Group reference'))!.id, reason: 'Use the allowed reference tab' };
      const field = page.elements.find((e) => e.kind === 'text')!;
      return field.value === '7' ? { kind: 'done', reason: 'Entered 7 in the allowed reference tab.' } : { kind: 'type', target: field.id, text: '7', reason: 'Enter reference value' };
    }
    if (page.text.includes('Results: 10 completed')) return { kind: 'done', reason: 'Observed results: 10 completed.' };
    const choice = page.elements.find((el) => el.kind === 'radio' && el.label.startsWith('42'));
    if (choice && !choice.checked) return { kind: 'click', target: choice.id, reason: 'Choose 42 (FIXTURE)' };
    const editor = page.elements.find((el) => el.kind === 'code');
    if (editor && !editor.value.includes('return 42;')) return { kind: 'type', target: editor.id, text: CODE, reason: 'Enter fixture code' };
    const next = page.elements.find((el) => el.label === 'Submit and next')!;
    return { kind: 'click', target: next.id, reason: 'Submit the answered question (FIXTURE)' };
  }, await fixturePort(), undefined, undefined, async (_question, page) => `FIXTURE reader received: ${page.text}`, async (text, _page, history, pending) => {
    if (pending) return { kind: 'approve', text: 'Proceeding with your approval (FIXTURE).' };
    if (text.includes('all ten')) return { kind: 'task', task: text, autoSubmit: true, text: 'Completing all ten questions (FIXTURE).' };
    if (text === 'Use group FIXTURE') return { kind: 'task', task: text, autoSubmit: false, text: 'Using the allowed group (FIXTURE).' };
    return { kind: 'answer', text: `The correct option is 42 (FIXTURE). ${history.length ? 'I remember the earlier conversation.' : ''}` };
  });
  const status = await agent.enable();
  context = await chromium.launchPersistentContext(join(folder, 'profile'), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const site = await context.newPage(); await site.goto(origin);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => popup.locator('#status').innerText()).toBe('No tab shared.');
  await site.bringToFront();
  await expect(popup.locator('#token')).toHaveCount(0);
  const failed = await popup.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: { runtime: { sendMessage: (x: unknown) => Promise<{ error?: string }> } } }).chrome;
    return api.runtime.sendMessage({ type: 'connect', port: 1 });
  });
  expect(failed.error).toContain('Invalid local connection port');
  // Valid port with no Doing bridge: polling must preserve the actual connection error.
  const unused = createServer(); await new Promise<void>((r) => unused.listen(0, '127.0.0.1', r));
  const unusedPort = (unused.address() as { port: number }).port;
  await new Promise<void>((r) => unused.close(() => r()));
  await popup.evaluate(async ({ port }) => {
    const api = (globalThis as unknown as { chrome: { runtime: { sendMessage: (x: unknown) => Promise<unknown> } } }).chrome;
    return api.runtime.sendMessage({ type: 'connect', port });
  }, { port: unusedPort });
  await expect.poll(() => popup.locator('#status').innerText()).toContain('Cannot reach Doing');
  await popup.waitForTimeout(1400);
  await expect(popup.locator('#status')).toContainText('Cannot reach Doing');
  const pendingConnection = popup.evaluate(({ port }) => {
    // Extension API belongs to the loaded fixture extension, not to the website.
    const api = (globalThis as unknown as { chrome: { runtime: { sendMessage: (x: unknown) => Promise<unknown> } } }).chrome;
    return api.runtime.sendMessage({ type: 'connect', port });
  }, { port: status.port });
  await expect.poll(() => agent!.status().connectionRequest?.id).toBeTruthy();
  agent.allowConnection(agent.status().connectionRequest!.id);
  const connectionReply = await pendingConnection as { error?: string };
  expect(connectionReply.error).toBeUndefined();
  await expect.poll(() => agent!.status().phase).toBe('ready');
  await expect.poll(() => agent!.status().pageReady).toBe(true);
  expect((await agent.ask('What question is on this page?')).text).toContain('What is six times seven?');
  expect(await site.locator('input:checked').count()).toBe(0);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const formatted = await panel.evaluate(async () => {
    const moduleUrl = new URL('format.js', location.href).href;
    const { formatMessage } = await import(moduleUrl) as { formatMessage: (text: string) => HTMLElement };
    const body = formatMessage('**Answer**\n```js\nconst value = "<img src=x onerror=alert(1)>";\n```\n<script>alert(1)</script>');
    return { bold: body.querySelector('strong')?.textContent, code: body.querySelector('pre')?.textContent, copy: body.querySelector('button')?.textContent, active: body.querySelectorAll('script,img,iframe,a').length };
  });
  expect(formatted).toMatchObject({ bold: 'Answer', copy: 'Copy', active: 0 });
  expect(formatted.code).toContain('<img');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await panel.getByLabel('Message Doing').fill('Which option is correct?');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(panel.locator('.message.assistant')).toContainText('correct option is 42');
  expect(await site.locator('input:checked').count()).toBe(0);
  await panel.getByLabel('Message Doing').fill('FIXTURE: answer all ten questions, submit each and continue until results.');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => {
    const s = agent!.status();
    if (s.phase === 'error' || s.phase === 'stopped') throw new Error(s.message);
    return s.phase;
  }, { timeout: 65000, intervals: [500] }).toBe('done');
  await expect(site.getByRole('heading', { name: 'Results: 10 completed' })).toBeVisible();
  const values = await site.evaluate(() => (window as unknown as { submissions: string[] }).submissions);
  expect(values).toEqual([...Array(9).fill('42'), CODE]);
  expect(agent.status().steps).toBe(20);
  await expect(panel.locator('.message.assistant').last()).toContainText('10 completed');
  await panel.getByLabel('Message Doing').fill('What did we discuss?');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(panel.locator('.message.assistant').last()).toContainText('remember the earlier conversation');
  const reference = await context.newPage(); await reference.goto(origin + '/reference'); await reference.bringToFront();
  const add = await panel.evaluate(({ port }) => {
    const api = (globalThis as unknown as { chrome: { runtime: { sendMessage: (x: unknown) => Promise<{ error?: string }> } } }).chrome;
    return api.runtime.sendMessage({ type: 'connect', port });
  }, { port: status.port });
  expect(add.error).toBeUndefined();
  await expect(panel.locator('.tab')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Group these tabs in Chrome' }).click();
  await panel.getByRole('button', { name: 'Browser automation FIXTURE', exact: true }).click();
  await expect(panel.locator('#connection')).toHaveText('Allowed pages are ready.');
  await panel.getByLabel('Message Doing').fill('Use group FIXTURE');
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(reference.locator('#result')).toHaveValue('7', { timeout: 15000 });
  await expect(panel.locator('.message.assistant').last()).toContainText('Entered 7');
  await reference.close();
  await expect(panel.locator('.tab')).toHaveCount(1);
  await expect.poll(()=>agent!.status().tabs.length).toBe(1);
  await expect.poll(()=>agent!.status().pageReady).toBe(true);
  await panel.getByLabel('Message Doing').fill('What is on the remaining page?');
  await panel.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(panel.locator('.message.assistant').last()).toContainText('correct option is 42');
  await panel.setViewportSize({ width: 390, height: 900 });
  await panel.screenshot({ path: testInfo.outputPath('sidepanel.png') });
  await context.close();
  context = await chromium.launchPersistentContext(join(folder, 'profile'), {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const restartedSite = await context.newPage(); await restartedSite.goto(origin);
  const restartedPopup = await context.newPage(); await restartedPopup.goto(`chrome-extension://${new URL(restartedWorker.url()).host}/popup.html`);
  await expect.poll(() => restartedPopup.locator('#status').innerText()).toBe('No tab shared.');
  const stored = await restartedWorker.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome;
    return !!(await api.storage.local.get('trustedHirora')).trustedHirora;
  });
  expect(stored).toBe(true);
  await restartedSite.bringToFront();
  const reconnected = await restartedPopup.evaluate(({ port }) => {
    const api = (globalThis as unknown as { chrome: { runtime: { sendMessage: (x: unknown) => Promise<{ error?: string }> } } }).chrome;
    return api.runtime.sendMessage({ type: 'connect', port });
  }, { port: status.port });
  expect(reconnected.error).toBeUndefined();
  expect(agent.status()).toMatchObject({ phase: 'ready', connectionRequest: null });
  await expect(restartedSite.getByRole('heading', { name: 'Question 1 of 10' })).toBeVisible();
  await restartedSite.waitForTimeout(1200);
  expect(await restartedSite.locator('input:checked').count()).toBe(0);
  await expect.poll(() => agent!.status().pageReady).toBe(true);
  await restartedPopup.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: { runtime: { sendMessage: (x: unknown) => Promise<unknown> } } }).chrome;
    return api.runtime.sendMessage({ type: 'stop' });
  });
  await expect.poll(() => restartedPopup.locator('#status').innerText()).toBe('Tab access revoked by you.');
  expect(agent.status()).toMatchObject({ tab: null, pageReady: false });
});
