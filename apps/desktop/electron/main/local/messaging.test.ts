import { it, expect, vi } from 'vitest';
import { messageRequest, requestsMessageSend, MessageTask } from './messaging';
import { LocalAgent } from './agent';
import type { LocalPlanner } from './agent';
import type { DesktopView, DesktopHost } from './desktop';
import type { PcHost } from './pc';
const goal = { recipient: 'Alex Example', body: 'HELLO FROM DOING', send: true };
const base: DesktopView = {
  handle: '123',
  processId: 1,
  process: 'WhatsApp.Root',
  title: 'WhatsApp',
  controls: [
    { id: 'header', name: 'Chat with: Alex Example', value: '', type: 'Text', actions: [] },
    { id: 'compose', name: 'Type a message', value: goal.body, type: 'Edit', actions: ['type', 'enter'] },
    { id: 'send', name: 'Send', value: '', type: 'Button', actions: ['click'] },
  ],
};
const send = { kind: 'app_action' as const, target: 'send', action: 'click' as const };
it('parses exact message text and a send-authorized follow-up only for an unfinished message', () => {
  expect(messageRequest('Message Alex Example in whatsapp "HELLO FROM DOING"')).toEqual(goal);
  expect(messageRequest('Send "HELLO FROM DOING" to Alex Example on WhatsApp')).toEqual(goal);
  expect(messageRequest('Just message the most frequent Alex Example the message', goal)).toEqual({ ...goal, frequent: true });
  expect(messageRequest('send it')).toBeNull();
  expect(messageRequest('send the same message to Sam', goal)?.recipient).toBe('Sam');
  expect(messageRequest('Send a different message instead', goal)).toBeNull();
  expect(requestsMessageSend('Message Alex on WhatsApp "Hello"')).toBe(true);
  expect(requestsMessageSend('Just text Alex hello')).toBe(true);
  expect(requestsMessageSend('Explain this message')).toBe(false);
  expect(requestsMessageSend('Draft a message, do not send')).toBe(false);
  expect(requestsMessageSend('Message Alex in WhatsApp "This is a draft. Do not send"')).toBe(true);
});
it('requires a verified chat header and exact draft before sending, and verifies a new chat message', () => {
  const task = new MessageTask(goal);
  expect(task.guard(base, send, base.controls[2]!)).toBe(true);
  expect(() => task.guard({ ...base, controls: base.controls.slice(1) }, send, base.controls[2]!)).toThrow('header');
  expect(() =>
    task.guard(
      { ...base, controls: base.controls.map((c) => (c.id === 'compose' ? { ...c, value: 'Wrong message' } : c)) },
      send,
      base.controls[2]!,
    ),
  ).toThrow('exact message');
  expect(task.confirmed(base, base)).toBe(false);
  const after = {
    ...base,
    controls: [
      ...base.controls.map((c) => (c.id === 'compose' ? { ...c, value: '' } : c)),
      { id: 'bubble', name: 'Sent: ' + goal.body, type: 'Text', value: '', actions: [] },
    ],
  };
  expect(task.confirmed(base, after)).toBe(true);
  expect(task.confirmed({ ...base, controls: [...base.controls, after.controls[3]!] }, after)).toBe(false); // old history cannot prove a new send
  task.attempted = true;
  expect(() => task.guard(base, send, base.controls[2]!)).toThrow('already attempted');
});
it('does not equate recent order with frequency or choose an arbitrary matching contact', () => {
  const contacts = {
    ...base,
    controls: ['one', 'two'].map((id) => ({ id, name: 'Alex Example', type: 'ListItem', value: '', actions: ['click'] })),
  };
  const task = new MessageTask({ ...goal, frequent: true });
  expect(task.ambiguous(contacts)).toBe(true);
  contacts.controls[0] = { ...contacts.controls[0]!, context: 'Frequency rank: 1' } as (typeof contacts.controls)[0];
  expect(task.ambiguous(contacts)).toBe(false);
  expect(() => task.guard(contacts, { kind: 'app_action', target: 'two', action: 'click' }, contacts.controls[1]!)).toThrow(
    'most frequent',
  );
});

function fixture() {
  let stage = 0;
  let search = '';
  let body = '';
  let sent = 0;
  let rank = false;
  let ambiguous = false;
  const observe = (): DesktopView => ({
    handle: '123',
    processId: 1,
    process: 'WhatsApp.Root',
    title: 'WhatsApp',
    controls:
      stage < 2
        ? [
            { id: 'search', name: 'Search contacts', type: 'Edit', value: search, actions: ['type', 'enter'] },
            ...(stage === 1
              ? [
                  {
                    id: 'contact',
                    name: 'Alex Example',
                    type: 'ListItem',
                    value: '',
                    context: rank ? 'Frequency rank: 1' : '',
                    actions: ['click'],
                  },
                  ...(ambiguous ? [{ id: 'other', name: 'Alex Example Work', type: 'ListItem', value: '', actions: ['click'] }] : []),
                ]
              : []),
          ]
        : [
            { ...base.controls[0]! },
            { ...base.controls[1]!, value: body },
            { ...base.controls[2]! },
            ...(sent ? [{ id: 'bubble' + sent, name: 'Sent: ' + goal.body, type: 'Text', value: '', actions: [] }] : []),
          ],
  });
  const desktop: DesktopHost = {
    inspect: vi.fn(async () => observe()),
    act: vi.fn(async (_view, c, a) => {
      if (c.id === 'search') {
        search = a.text ?? '';
        stage = 1;
      }
      if (c.id === 'contact') stage = 2;
      if (c.id === 'compose') body = a.text ?? '';
      if (c.id === 'send') {
        sent++;
        body = '';
      }
      return observe();
    }),
  };
  const pc = {
    listApps: async () => [{ name: 'WhatsApp', id: 'wa' }],
    launchApp: vi.fn(async () => {}),
    openUri: vi.fn(async () => {}),
  } as unknown as PcHost;
  const plan: LocalPlanner = vi.fn<LocalPlanner>(async (_text, ctx) => {
    const p = JSON.parse(ctx.observation.slice(ctx.observation.indexOf('{'))) as DesktopView;
    const controls = p.controls;
    const search = controls.find((c) => c.id === 'search');
    if (search && !search.value) return { kind: 'app_action', target: 'search', action: 'type', text: goal.recipient };
    if (controls.some((c) => c.id === 'contact')) return { kind: 'app_action', target: 'contact', action: 'click' };
    if (controls.find((c) => c.id === 'compose')?.value !== goal.body)
      return { kind: 'app_action', target: 'compose', action: 'type', text: goal.body };
    return { kind: 'app_action', target: 'send', action: 'click' };
  });
  return {
    desktop,
    pc,
    plan,
    count: () => sent,
    setRank: () => {
      rank = true;
    },
    setAmbiguous: (value: boolean) => {
      ambiguous = value;
    },
  };
}
it('hands opening WhatsApp directly to observed app control and completes search, draft and one send', async () => {
  const f = fixture();
  const agent = new LocalAgent(f.plan, undefined, f.pc, f.desktop);
  agent.desktopAccess(true);
  agent.send('Message Alex Example in whatsapp "HELLO FROM DOING"');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(f.count()).toBe(1);
  expect(f.pc.launchApp).toHaveBeenCalledOnce();
  expect(f.plan).not.toHaveBeenCalled();
  expect(f.desktop.act).toHaveBeenCalledTimes(4);
  expect(agent.status().messages.at(-1)?.text).toContain('appears in Alex Example');
  expect(agent.status().messages.at(-1)?.text).not.toContain('Read its controls');
});
it('keeps exact unfinished content for the most-frequent follow-up and clears it after completion', async () => {
  const f = fixture();
  f.setAmbiguous(true);
  const planner = f.plan;
  const agent = new LocalAgent(planner, undefined, f.pc, f.desktop);
  agent.desktopAccess(true);
  agent.send('Message Alex Example in whatsapp "HELLO FROM DOING"');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(f.count()).toBe(0);
  f.setAmbiguous(false);
  f.setRank();
  agent.send('Just message the most frequent Alex Example the message');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(f.count()).toBe(1);
  agent.send('send it');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(f.count()).toBe(1);
});
it('does not claim success when WhatsApp exposes no chat controls', async () => {
  const f = fixture();
  f.desktop.inspect = vi.fn(async () => ({ ...base, controls: [] }));
  const agent = new LocalAgent(f.plan, undefined, f.pc, f.desktop);
  agent.desktopAccess(true);
  vi.useFakeTimers();
  try {
    agent.send('Message Alex Example in whatsapp "HELLO FROM DOING"');
    await vi.runAllTimersAsync();
    expect(agent.status().busy).toBe(false);
    expect(agent.status().messages.at(-1)?.text).toContain('Nothing was sent');
    expect(f.count()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
