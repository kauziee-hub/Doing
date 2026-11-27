import { expect, it, vi } from 'vitest';
import { LocalAgent } from './agent';
import { checkDesktopAction, modelDesktopView } from './desktop';
import type { DesktopHost, DesktopView } from './desktop';
import type { FileAction, LocalPlanner } from './agent';
import { taskEffort } from '../taskEffort';
import { appActionSchema } from './planner';

const view: DesktopView = { handle: '123', processId: 7, process: 'Fixture', title: 'Fixture — Alex', controls: [
  { id: 'message', name: 'Message', type: 'Edit', value: '', actions: ['type', 'enter'] },
  { id: 'send', name: 'Send', type: 'Button', value: '', actions: ['click'] },
] };
const click = { kind: 'app_action' as const, target: 'send', action: 'click' as const };
it('requires observed controls and explicit current-request authority to send', () => {
  expect(() => checkDesktopAction(click, view, 'Draft hello to Alex')).toThrow('explicitly');
  expect(() => checkDesktopAction(click, view, 'Send hello, do not send yet')).toThrow('explicitly');
  expect(() => checkDesktopAction(click, view, 'Explain how to send')).toThrow('question');
  expect(checkDesktopAction(click, view, 'Send hello to Alex').id).toBe('send');
  expect(() => checkDesktopAction({ ...click, target: 'invented' }, view, 'Send hello')).toThrow('changed');
  expect(() => checkDesktopAction({ ...click, action: 'type' }, view, 'Type hello')).toThrow('changed');
});
it('blocks sensitive controls even if the model requests them', () => {
  for (const name of ['Password', 'Buy now', 'Windows Security', 'Permanently delete', 'Install now']) {
    expect(() => checkDesktopAction(click, { ...view, controls: [{ ...view.controls[1]!, name }] }, 'Click and send')).toThrow('sensitive');
  }
});
it('keeps native element identities out of the model and bounds whole control records', () => {
  const output = modelDesktopView({ ...view, controls: Array.from({ length: 180 }, (_, i) => ({ ...view.controls[0]!, id: String(i), name: 'a'.repeat(200), runtime: 'PRIVATE_RUNTIME', value: 'b'.repeat(700) })) });
  expect(output).not.toContain('PRIVATE_RUNTIME');
  expect(JSON.parse(output).omitted).toBe(true);
  expect(output.length).toBeLessThan(10500);
});
it('constrains model output to fresh observed IDs and the actions each control supports', () => {
  const schema = appActionSchema(modelDesktopView(view));
  const variants = (schema.oneOf ?? schema.anyOf) as Array<{properties:Record<string,Record<string,unknown>>}>;
  const controls = variants.filter(v=>v.properties.kind?.const==='app_action');
  expect(controls[0]?.properties.target?.enum).toEqual(['message','send']);
  expect(controls[0]?.properties.action?.enum).toEqual(['type','enter','click']);
  const empty = appActionSchema(modelDesktopView({...view, controls:[]}));
  expect(JSON.stringify(empty)).not.toContain('"enum":[]');
});
it('requires session app permission, refreshes after each action, and revocation stops late model actions', async () => {
  const host: DesktopHost = { inspect: vi.fn(async () => structuredClone(view)), act: vi.fn(async () => ({ ...view, controls: [{ ...view.controls[0]!, id: 'fresh', value: 'Hello' }] })) };
  const queue = (): LocalPlanner => { let i = 0; const actions: FileAction[] = [{kind:'inspect_app',name:'Fixture'}, {kind:'app_action',target:'message',action:'type',text:'Hello'}, {kind:'done',text:'Sent!'}]; return async () => actions[i++]!; };
  const blocked = new LocalAgent(queue(), undefined, undefined, host);
  blocked.send('Type hello in Fixture');
  await vi.waitFor(() => expect(blocked.status().busy).toBe(false));
  expect(host.inspect).not.toHaveBeenCalled();
  const agent = new LocalAgent(queue(), undefined, undefined, host);
  agent.desktopAccess(true); agent.send('Type hello in Fixture');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(host.act).toHaveBeenCalledOnce();
  expect(agent.status().messages.at(-1)?.text).toContain('Entered text');
  expect(agent.status().messages.at(-1)?.text).not.toContain('Sent!');
  let release!: (a: FileAction) => void;
  const late = new LocalAgent(async () => new Promise(r => { release = r; }), undefined, undefined, host);
  late.desktopAccess(true); late.send('Type hello in Fixture');
  await vi.waitFor(() => expect(release).toBeDefined());
  late.desktopAccess(false); release({kind:'inspect_app',name:'Fixture'});
  await vi.waitFor(() => expect(late.status().busy).toBe(false));
  expect(host.inspect).toHaveBeenCalledTimes(1);
});
it('uses thinking for difficult tasks on GPU, while ordinary PC actions stay fast', () => {
  expect(taskEffort('Implement a dynamic programming solution', true)).toBe('deep');
  expect(taskEffort('Think carefully and solve this coding question', true)).toBe('deep');
  expect(taskEffort('Open Spotify', true)).toBe('fast');
  expect(taskEffort('Think carefully', false)).toBe('fast');
});
it('rereads a changed app and replans before retrying an action that never executed', async () => {
  const inspect = vi.fn(async () => structuredClone(view));
  const act = vi.fn().mockRejectedValueOnce(new Error('The app changed while I was thinking.')).mockResolvedValueOnce(view);
  const plan: LocalPlanner = async (_text,context) => context.recent.some(r=>r.startsWith('Entered text'))
    ? {kind:'done',text:'Finished'} : context.recent.length ? {kind:'app_action',target:'message',action:'type',text:'Hello'} : {kind:'inspect_app',name:'Fixture'};
  const agent = new LocalAgent(plan,undefined,undefined,{inspect,act});
  agent.desktopAccess(true); agent.send('Type Hello in Fixture');
  await vi.waitFor(()=>expect(agent.status().busy).toBe(false));
  expect(inspect).toHaveBeenCalledTimes(2); expect(act).toHaveBeenCalledTimes(2);
  expect(agent.status().messages.at(-1)?.text).toContain('Entered text');
});
