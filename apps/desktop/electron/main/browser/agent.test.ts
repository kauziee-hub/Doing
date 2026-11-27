import { fixturePort } from '../../../../../tests/fixtures/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAction, BrowserSnapshot } from '@doing/contracts';
import { BrowserAgent, checkAction, parsePlan } from './agent';
import type { BrowserReader } from './agent';
import type { BrowserChatter } from './chat';
import type { BrowserGrant } from './trust';

const page = (overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({
  revision: 'rev1',
  url: 'https://practice.example/questions',
  title: 'Practice',
  text: 'Question 1. Two plus two?',
  elements: [
    { id: 'a', kind: 'radio', label: '4', value: '', advances: false, checked: false },
    { id: 'next', kind: 'button', label: 'Submit and next', value: '', advances: true },
  ],
  ...overrides,
});
const agents: BrowserAgent[] = [];
afterEach(() => {
  for (const agent of agents) agent.disable();
  agents.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(
  action: BrowserAction | ((p: BrowserSnapshot) => BrowserAction) = { kind: 'click', target: 'next', reason: 'Continue' },
  read?: BrowserReader,
  converse?: BrowserChatter,
) {
  const planner = vi.fn(async (_task, snapshot) => (typeof action === 'function' ? action(snapshot) : action));
  const agent = new BrowserAgent(planner, await fixturePort(), undefined, undefined, read, converse);
  agents.push(agent);
  const status = await agent.enable();
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${status.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${status.pairingCode}`, ...headers },
      body: JSON.stringify(body),
    });
  const connected = await post('/connect', { title: 'Practice', url: page().url });
  const { clientId } = (await connected.json()) as { clientId: string };
  const tick = async (data: Record<string, unknown> = {}) =>
    (await post('/tick', { clientId, ...data })).json() as Promise<{
      phase: string;
      observe: boolean;
      command?: { id: string; runId: string; action: BrowserAction };
    }>;
  const start = (autoSubmit = false, maxSteps = 150) =>
    agent.start({ task: 'Complete all ten practice questions.', consent: true, autoSubmit, maxSteps });
  return { agent, planner, post, clientId, tick, start };
}

describe('browser task permissions and lifecycle', () => {
  it('reads a whole-page chat through scrolling without consulting the action planner', async () => {
    const read = vi.fn(async (_q: string, p: BrowserSnapshot) => p.text.includes('Final section') ? 'First and final sections summarized.' : 'First section summary.');
    const converse = vi.fn(async () => ({kind:'answer' as const,text:'Should not be used'}));
    const {agent,tick,planner} = await setup({kind:'click',target:'next',reason:'Must never click'},read,converse);
    const first = page({text:'First section',scroll:{top:0,max:800,height:800}});
    await tick({snapshot:first});
    await agent.chat('9451abc7-e876-4a01-b991-b3e50cb4fcc1','Go through this page and tell me what it is about');
    const scroll = await tick({snapshot:first});
    expect(scroll.command?.action).toMatchObject({kind:'scroll',direction:'down'});
    const result = await tick({snapshot:page({revision:'bottom',text:'Final section',scroll:{top:800,max:800,height:800}}),receipt:{id:scroll.command!.id,ok:true,message:'Scrolled'}});
    expect(result.phase).toBe('done');
    expect(planner).not.toHaveBeenCalled(); expect(converse).not.toHaveBeenCalled();
    expect(agent.status().autoSubmit).toBe(false);
    expect(agent.status().messages.at(-1)?.text).toContain('final sections');
  });
  it('requires a full editor replacement to preserve the requested JavaScript function', () => {
    const codePage = page({ elements: [{ id: 'code', kind: 'code', label: 'JavaScript', value: 'var twoSum = function(nums, target) { };', advances: false }] });
    expect(checkAction({ kind: 'type', target: 'code', text: 'return [];', reason: 'Incomplete' }, codePage, 'Solve and preserve the signature')).toContain('omits');
    expect(checkAction({ kind: 'type', target: 'code', text: 'function twoSum(nums, target) { return []; }', reason: 'Complete' }, codePage, 'Solve and preserve the signature')).toBeNull();
    expect(checkAction({ kind: 'type', target: 'code', text: 'hello', reason: 'Explicit replacement' }, codePage, 'Replace the editor with hello')).toBeNull();
  });
  it('advances a confirmed single-group MCQ only with explicit batch submission permission', async () => {
    const { agent, start, tick, planner } = await setup({ kind: 'click', target: 'a', reason: 'Choose the answer' });
    const current = page({
      text: 'Question 1 of 10',
      elements: [
        { id: 'a', kind: 'radio', label: '4', value: '', advances: false, checked: false, group: 'one' },
        { id: 'next', kind: 'button', label: 'Submit and next', value: '', advances: true },
      ],
    });
    start(true);
    const first = await tick({ snapshot: current });
    const selected = {
      ...current,
      revision: 'selected',
      elements: current.elements.map((el) => (el.id === 'a' ? { ...el, checked: true } : el)),
    };
    const next = await tick({ snapshot: selected, receipt: { id: first.command!.id, ok: true, message: 'Selected' } });
    expect(next.command?.action).toMatchObject({ kind: 'click', target: 'next' });
    expect(planner).toHaveBeenCalledTimes(1);
    agent.stop();
    start(false);
    const calls = planner.mock.calls.length;
    await tick({ snapshot: selected });
    expect(planner.mock.calls.length).toBeGreaterThan(calls);
    expect(agent.status().autoSubmit).toBe(false);
  });
  it('does not claim a batch is finished while a numbered question remains editable', async () => {
    const { agent, tick, start, planner } = await setup({ kind: 'done', reason: 'Incorrect model completion' });
    start(true);
    expect(await tick({ snapshot: page({ text: 'Question 2 of 10. What is 9 plus 8?' }) })).toMatchObject({ phase: 'error' });
    expect(planner).toHaveBeenCalledTimes(2);
    expect(agent.status().message).toContain('still visible');
  });
  it('removes one tab and ignores an in-flight observation that still mentions it', async () => {
    const { agent, post, clientId, tick } = await setup();
    const first = { id: 'first', title: 'Practice', url: page().url };
    const second = { id: 'second', title: 'Reference', url: 'https://reference.example/' };
    for (const tab of [first, second]) expect((await post('/tabs/allow', { clientId, tab })).status).toBe(200);
    const stale = page({
      tabId: 'second',
      url: second.url,
      tabs: [
        { ...first, text: '' },
        { ...second, text: '' },
      ],
    });
    await tick({ snapshot: stale });
    expect((await post('/tabs/remove', { clientId, id: 'second' })).status).toBe(200);
    expect(await tick({ snapshot: stale })).toMatchObject({ phase: 'ready', observe: true });
    await tick({ snapshot: page({ tabId: 'first', tabs: [{ ...first, text: '' }] }) });
    expect(agent.status()).toMatchObject({ phase: 'ready', pageReady: true, tabs: [first] });
  });
  it('runs chat tasks, gates submission from the current message, replies on completion and preserves follow-ups', async () => {
    const histories: number[] = [];
    const converse: BrowserChatter = async (text, _page, history, pending) => {
      histories.push(history.length);
      if (pending) return { kind: 'approve', text: 'Approved.' };
      return text.includes('Fill')
        ? { kind: 'task', task: text, autoSubmit: true, text: 'Filling now.' }
        : { kind: 'answer', text: 'Read-only answer.' };
    };
    const { agent, tick, planner } = await setup(
      (p) =>
        p.text === 'Results' ? { kind: 'done', reason: 'Finished on results.' } : { kind: 'click', target: 'next', reason: 'Submit' },
      undefined,
      converse,
    );
    await tick({ snapshot: page() });
    const id = '36db31c4-381e-44cd-98bb-6a217156b86b';
    await agent.chat(id, 'Fill the answers, do not submit.');
    await agent.chat(id, 'Fill the answers, do not submit.');
    expect(histories).toEqual([0]);
    expect(agent.status().autoSubmit).toBe(false); // Reject the fixture model's excessive permission.
    await tick({ snapshot: page() });
    expect(agent.status().phase).toBe('error');
    expect(agent.status().messages.at(-1)?.text).toContain('not to submit');
    await agent.chat('31c72f5e-4b18-40e2-a880-2c51fd1492a7', 'Fill the answers and submit.');
    const command = await tick({ snapshot: page() });
    await tick({
      snapshot: page({ text: 'Results', revision: 'results' }),
      receipt: { id: command.command!.id, ok: true, message: 'Submitted' },
    });
    expect(agent.status().messages.at(-1)?.text).toBe('Finished on results.');
    const calls = planner.mock.calls.length;
    await agent.chat('525b743c-6faf-4d32-91cf-0e1c16473730', 'Explain the result.');
    expect(agent.status().messages.at(-1)?.text).toBe('Read-only answer.');
    expect(histories.at(-1)).toBeGreaterThan(4);
    expect(planner.mock.calls.length).toBe(calls);
  });
  it('rejects a model switch to an unapproved tab', async () => {
    const { agent, start, tick } = await setup({ kind: 'switch', tab: 'unapproved', reason: 'Bad model request' });
    start(true);
    expect(await tick({ snapshot: page() })).toMatchObject({ phase: 'error' });
    expect(agent.status().message).toContain('not an available');
  });
  it('remembers an explicitly approved browser across app restarts without restoring tab/task access', async () => {
    let saved: BrowserGrant | null = null;
    const store = {
      load: () => saved,
      save: (grant: BrowserGrant) => {
        saved = grant;
      },
      clear: () => {
        saved = null;
      },
    };
    const planner = vi.fn(async () => ({ kind: 'done' as const, reason: 'Complete' }));
    let agent = new BrowserAgent(planner, await fixturePort(), store);
    agents.push(agent);
    let status = await agent.enable();
    const token = 'ab'.repeat(24);
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    const post = (path: string, body: unknown, requestOrigin = origin) =>
      fetch(`http://127.0.0.1:${status.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: requestOrigin, connection: 'close' },
        body: JSON.stringify(body),
      });
    expect((await post('/pair/request', { label: 'Companion' }, 'https://malicious.example')).status).toBe(403);
    const { requestId } = (await (await post('/pair/request', { label: 'Companion' })).json()) as { requestId: string };
    expect(agent.status().connectionRequest?.id).toBe(requestId);
    expect((await post('/connect', { title: 'Practice', url: page().url })).status).toBe(401);
    agent.allowConnection(requestId);
    expect(saved).toEqual({ token, extensionId: 'a'.repeat(32) });
    expect(await (await post('/pair/status', { requestId })).json()).toEqual({ state: 'approved' });
    expect((await post('/connect', { title: 'Practice', url: page().url }, `chrome-extension://${'b'.repeat(32)}`)).status).toBe(403);
    const { clientId } = (await (await post('/connect', { title: 'Practice', url: page().url })).json()) as { clientId: string };
    expect(await (await post('/tick', { clientId, snapshot: page() })).json()).toMatchObject({ phase: 'ready', observe: true });
    agent.shutdown();
    expect(saved).toBeTruthy();
    agent = new BrowserAgent(planner, await fixturePort(), store);
    agents.push(agent);
    status = await agent.enable();
    expect(agent.status()).toMatchObject({ trustedBrowser: true, pairingCode: null, tab: null, task: '', connectionRequest: null });
    expect((await post('/tick', { clientId })).status).toBe(400);
    expect((await post('/connect', { title: 'Practice', url: page().url })).status).toBe(200);
    expect(planner).not.toHaveBeenCalled();
    agent.disable();
    expect(saved).toBeNull();
    status = await agent.enable();
    expect((await post('/connect', { title: 'Practice', url: page().url })).status).toBe(401);
  });
  it('declines and expires unapproved connection requests', async () => {
    const { agent, post } = await setup();
    const origin = `chrome-extension://${'c'.repeat(32)}`;
    const { requestId } = (await (await post('/pair/request', { label: 'Companion' }, { origin })).json()) as { requestId: string };
    agent.denyConnection(requestId);
    expect(await (await post('/pair/status', { requestId }, { origin })).json()).toEqual({ state: 'denied' });
    expect(() => agent.allowConnection(requestId)).toThrow();
    const next = (await (await post('/pair/request', { label: 'Companion' }, { origin })).json()) as { requestId: string };
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000);
    expect(agent.status().connectionRequest).toBeNull();
    expect(() => agent.allowConnection(next.requestId)).toThrow();
    expect(agent.status().trustedBrowser).toBe(false);
  });
  it('reads an allowed tab for questions without planning or operating before Start task', async () => {
    const reader = vi.fn(async (_question, snapshot) => `Answer from ${snapshot.text}`);
    const { tick, planner, agent, post, clientId } = await setup(undefined, reader);
    await expect(agent.ask('Which option?')).rejects.toThrow('Waiting for the allowed tab');
    expect(await tick({ snapshot: page() })).toMatchObject({ observe: true, phase: 'ready' });
    expect(agent.status().pageReady).toBe(true);
    expect(await agent.ask('Which option?')).toEqual({ text: 'Answer from Question 1. Two plus two?', url: page().url });
    expect(reader.mock.calls[0]?.[1]).toEqual(page());
    expect(planner).not.toHaveBeenCalled();
    expect(() => agent.start({ task: 'x', consent: false, autoSubmit: false } as never)).toThrow();
    await post('/disconnect', { clientId });
    expect(agent.status()).toMatchObject({ pageReady: false, tab: null });
    await expect(agent.ask('Which option?')).rejects.toThrow('Waiting for the allowed tab');
  });
  it('discards idle observations on cross-site navigation and a lost connection', async () => {
    const { tick, agent } = await setup();
    await tick({ snapshot: page() });
    await tick({ snapshot: page({ url: 'https://other.example' }) });
    expect(agent.status()).toMatchObject({ tab: null, pageReady: false });
    const next = await setup();
    await next.tick({ snapshot: page() });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    expect(next.agent.status()).toMatchObject({ tab: null, pageReady: false, phase: 'disconnected' });
  });
  it('does not return an answer after tab revocation or a changed page', async () => {
    let finish!: (text: string) => void;
    const reader: BrowserReader = () =>
      new Promise((r) => {
        finish = r;
      });
    const { tick, agent, post, clientId } = await setup(undefined, reader);
    await tick({ snapshot: page() });
    const answer = agent.ask('Which option?');
    await tick({ snapshot: page({ revision: 'new-question' }) });
    finish('Old answer');
    await expect(answer).rejects.toThrow('page changed');
    const revoked = agent.ask('Which option?');
    await post('/disconnect', { clientId });
    finish('Revoked answer');
    await expect(revoked).rejects.toThrow();
  });
  it('rejects missing auth, hostile origins, stale clients and oversized bodies', async () => {
    const { post } = await setup();
    expect((await post('/tick', {}, { authorization: '' })).status).toBe(401);
    expect((await post('/tick', {}, { origin: 'https://malicious.example' })).status).toBe(403);
    expect((await post('/tick', { clientId: '7a1c237d-a187-4c25-9693-52aa99455691' })).status).toBe(400);
    expect((await post('/tick', { text: 'x'.repeat(400001) })).status).toBe(413);
  });
  it('requires review for submit/next and approves only the observed page', async () => {
    const { agent, tick, start } = await setup();
    start();
    expect(await tick({ snapshot: page() })).toMatchObject({ phase: 'review', observe: false });
    expect(agent.status().pending?.label).toBe('Submit and next');
    agent.approve();
    const approved = await tick({ snapshot: page() });
    expect(approved.command?.action).toMatchObject({ kind: 'click', target: 'next' });
  });
  it('does not carry approval onto a changed question', async () => {
    const { agent, tick, start } = await setup();
    start();
    await tick({ snapshot: page() });
    agent.approve();
    expect(await tick({ snapshot: page({ revision: 'rev2', text: 'Another question' }) })).toMatchObject({
      phase: 'review',
      observe: false,
    });
  });
  it('continues through 10 questions and only finishes on visible results', async () => {
    const { agent, tick, start } = await setup((p) =>
      p.text === 'Results: 10 completed'
        ? { kind: 'done', reason: 'Results: 10 completed' }
        : { kind: 'click', target: 'next', reason: 'Next question' },
    );
    start(true);
    let receipt;
    for (let i = 0; i < 10; i++) {
      const reply = await tick({ snapshot: page({ revision: `r${i}`, text: `Question ${i + 1} of 10` }), receipt });
      expect(reply.command?.action.kind).toBe('click');
      receipt = { id: reply.command!.id, ok: true, message: 'Next loaded' };
    }
    expect(await tick({ receipt, snapshot: page({ revision: 'results', text: 'Results: 10 completed', elements: [] }) })).toMatchObject({
      phase: 'done',
    });
    expect(agent.status().steps).toBe(10);
  });
  it('never replays an unacknowledged submission', async () => {
    const { agent, tick, start } = await setup();
    start(true);
    await tick({ snapshot: page() });
    expect(await tick({ snapshot: page() })).toMatchObject({ phase: 'error', observe: false });
    expect(agent.status().steps).toBe(0);
  });
  it('cancels pending inference and prevents commands after Stop', async () => {
    let finish!: (action: BrowserAction) => void;
    const { agent, start, tick, planner } = await setup();
    planner.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    start(true);
    const pending = tick({ snapshot: page() });
    await vi.waitFor(() => expect(planner).toHaveBeenCalled());
    agent.stop();
    finish({ kind: 'click', target: 'next', reason: 'Late answer' });
    expect(await pending).toMatchObject({ phase: 'stopped', observe: false });
  });
  it('keeps the connection alive while an authenticated tick waits on slow local inference', async () => {
    const { agent, start, tick, planner } = await setup();
    const before = Date.now();
    planner.mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(before + 40_000);
      return { kind: 'click', target: 'next', reason: 'Slow local model' };
    });
    start(true);
    expect((await tick({ snapshot: page() })).command?.action.kind).toBe('click');
    expect(agent.status()).toMatchObject({ phase: 'running', tab: { title: 'Practice' } });
  });
  it('revokes commands, client and pairing token on disable', async () => {
    const { agent, start, tick, post, clientId } = await setup();
    start(true);
    const reply = await tick({ snapshot: page() });
    agent.stop();
    expect(await (await post('/permit', { clientId, runId: reply.command!.runId, commandId: reply.command!.id })).json()).toEqual({
      allowed: false,
    });
    expect(agent.disable()).toMatchObject({ phase: 'off', pairingCode: null, tab: null });
  });
  it('expires task permission and rejects an expired one-action approval', async () => {
    const { agent, start, tick } = await setup();
    start();
    await tick({ snapshot: page() });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    await tick({ snapshot: page() }); // The tab is still polling; only the task lease expired.
    expect(() => agent.approve()).toThrow('There is no action waiting for approval.');
    expect(agent.status()).toMatchObject({ phase: 'stopped', pending: null });
  });
  it('stops when the browser reports an action failed', async () => {
    const { tick, start, agent } = await setup();
    start(true);
    const result = await tick({ snapshot: page() });
    expect(await tick({ receipt: { id: result.command!.id, ok: false, message: 'Control changed' } })).toMatchObject({
      phase: 'error',
      observe: false,
    });
    expect(agent.status().message).toContain('Control changed');
  });
  it('stops on an origin change and enforces action limits', async () => {
    const { tick, start, agent } = await setup();
    start(true, 1);
    const reply = await tick({ snapshot: page() });
    expect(await tick({ receipt: { id: reply.command!.id, ok: true, message: 'ok' }, snapshot: page({ revision: 'r2' }) })).toMatchObject({
      phase: 'stopped',
    });
    start(true);
    expect(await tick({ snapshot: page({ url: 'https://other.example' }) })).toMatchObject({ phase: 'stopped' });
    expect(agent.status().tab).toBeNull();
  });
  it('rejects invalid targets and option values instead of executing model instructions', () => {
    expect(checkAction({ kind: 'type', target: 'next', text: 'x', reason: 'bad' }, page())).toBeTruthy();
    expect(checkAction({ kind: 'click', target: 'document.body', reason: 'bad' }, page())).toBeTruthy();
    expect(() => parsePlan('{"kind":"evaluate","script":"alert(1)"}')).toThrow();
    expect(parsePlan('```json\n{"kind":"done","reason":"Results shown"}\n```')).toMatchObject({ kind: 'done' });
  });
});
