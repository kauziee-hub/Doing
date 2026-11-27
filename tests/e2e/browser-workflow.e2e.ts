import { test, expect, chromium } from '@playwright/test';
import { BrowserAgent } from '../../apps/desktop/electron/main/browser/agent';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fixturePort } from '../fixtures/ports';

// Deterministic FIXTURE planner verifies extension I/O and continuation, not answer quality.
const ELEVEN_FIXTURE = `<!doctype html><title>Eleven questions FIXTURE</title>
<style>body{margin:0;font:16px system-ui}aside{position:fixed;left:0;top:0;width:160px;height:90vh;overflow:auto}aside div{height:1600px}main{margin-left:180px;padding:20px}label{display:block;padding:10px}button{padding:14px;margin:15px}</style>
<aside><div>Unrelated contents sidebar</div></aside><main><button id="final">Submit Assessment</button><span id="notice">Ready</span><div id="question"></div></main>
<script>let index=1;window.answers=[];window.finalSubmissions=0;window.nextClicks=0;
document.getElementById('final').onclick=()=>window.finalSubmissions++;
function render(){const multi=index%2===1;document.getElementById('question').innerHTML='<h2>Question '+index+' / 11</h2><article><p>'+ (multi?'Select all numbers smaller than 3.':'Select the number equal to 1.') +'</p></article><section><strong>Options</strong>'+[1,2,3].map(v=>'<label><input type="'+(multi?'checkbox':'radio')+'" name="answer" value="'+v+'">'+v+'</label>').join('')+'</section><span hidden>'+ 'x'.repeat(4500)+'</span>'+(index<11?'<button id="next" aria-label="Next">Next →</button>':'');const next=document.getElementById('next');if(next)next.onclick=()=>{window.nextClicks++;if(next.disabled)return;next.disabled=true;window.answers.push({index,values:[...document.querySelectorAll('input:checked')].map(e=>e.value)});setTimeout(()=>{index++;render()},1400)};}render();</script>`;

test('eleven split-column mixed-choice questions survive a stale plan and delayed Next, without final submission', async () => {
  test.setTimeout(150000);
  const folder = await mkdtemp(join(tmpdir(), 'doing-workflow-fixture-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(ELEVEN_FIXTURE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  const origin = `http://127.0.0.1:${address.port}`;
  let agent: BrowserAgent | undefined;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    const extension = join(folder, 'extension');
    await cp(resolve('apps/desktop/resources/browser-extension'), extension, {
      recursive: true,
    });
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push(origin + '/*');
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(join(folder, 'profile'), {
      headless: true,
      channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const site = await context.newPage();
    await site.goto(origin);
    let injected = false;
    agent = new BrowserAgent(
      async (_task, page) => {
        if (!injected) {
          injected = true;
          await site.locator('#notice').evaluate((el) => (el.textContent = 'Changed while planning'));
        }
        const multi = page.text.includes('all numbers');
        const target = page.elements.find(
          (el) => ['radio', 'checkbox'].includes(el.kind) && !el.checked && (/^1(?: |$)/.test(el.label) || (multi && /^2(?: |$)/.test(el.label))),
        );
        return target
          ? {
              kind: 'click',
              target: target.id,
              reason: 'Select fixture choice',
            }
          : { kind: 'done', reason: 'Current choices reviewed (FIXTURE)' };
      },
      await fixturePort(),
      undefined,
      undefined,
      undefined,
      async (text) => ({
        kind: 'task',
        task: text,
        autoSubmit: true,
        text: 'Working through eleven fixture questions.',
      }),
    );
    const state = await agent.enable();
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await site.bringToFront();
    const connection = panel.evaluate(async (port) => {
      const api = (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage: (x: unknown) => Promise<unknown> };
          };
        }
      ).chrome;
      return api.runtime.sendMessage({ type: 'connect', port });
    }, state.port);
    await expect.poll(() => agent!.status().connectionRequest?.id).toBeTruthy();
    agent.allowConnection(agent.status().connectionRequest!.id);
    await connection;
    await expect.poll(() => agent!.status().pageReady).toBe(true);
    await panel
      .getByLabel('Message Doing')
      .fill('Solve all the 11 questions by filling the options and going next. Do not submit the assessment.');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    let last='';
    await expect.poll(()=>{const state=agent!.status();if(state.message!==last){last=state.message;console.log(state.phase,state.steps,last);}if(state.phase==='error'){throw new Error(state.message);}return state.phase;},{timeout:110000}).toBe('done');
    const result = await site.evaluate(() => ({
      answers: (window as unknown as { answers: unknown[] }).answers,
      last: [...document.querySelectorAll<HTMLInputElement>('input:checked')].map((e) => e.value),
      nextClicks: (window as unknown as { nextClicks: number }).nextClicks,
      submits: (window as unknown as { finalSubmissions: number }).finalSubmissions,
    }));
    expect(result.answers).toEqual(
      Array.from({ length: 10 }, (_, i) => ({
        index: i + 1,
        values: (i + 1) % 2 ? ['1', '2'] : ['1'],
      })),
    );
    expect(result.last).toEqual(['1', '2']);
    expect(result.nextClicks).toBe(10);
    expect(result.submits).toBe(0);
    expect(agent.status().steps).toBe(27);
    expect(agent.status().message).toContain('11 of 11');
  } finally {
    agent?.disable();
    await context?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (resolve(folder).startsWith(resolve(tmpdir()) + sep + 'doing-workflow-fixture-')) await rm(folder, { recursive: true, force: true });
  }
});
