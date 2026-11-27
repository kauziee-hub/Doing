import { expect, it } from 'vitest';
import { createAnswerProvider, validateLocalBaseUrl } from '../../packages/providers/src';
import { createBrowserPlanner } from '../../apps/desktop/electron/main/browser/planner';
import type { BrowserSnapshot } from '@doing/contracts';
import { createBrowserChatter } from '../../apps/desktop/electron/main/browser/chat';

it.skipIf(!process.env.DOING_BROWSER_MODEL_CHECK)('real local model plans an MCQ selection, coding answer and observed completion', async () => {
  const base = process.env.DOING_BROWSER_MODEL_URL || 'http://127.0.0.1:11434/v1';
  if (!validateLocalBaseUrl(base)) throw new Error('Local model check requires a loopback URL');
  const provider = createAnswerProvider({ baseUrl: base });
  const model = process.env.DOING_BROWSER_MODEL || 'qwen3.5:4b';
  const plan = createBrowserPlanner({
    engine: { status: () => ({ ready: true, tier: 'gpu' }) },
    ensureEngine: async () => {},
    resolveProvider: () => ({ provider, model, deepModel: model }),
  });
  const converse = createBrowserChatter({ engine: { status: () => ({ ready: true, tier: 'gpu' }) }, ensureEngine: async () => {}, resolveProvider: () => ({ provider, model, deepModel: model }) });
  const page: BrowserSnapshot = {
    revision: 'fixture', url: 'https://practice.example', title: 'Local model practice FIXTURE',
    text: 'Question 1 of 10. What is 6 times 7? Choices: 41, 42.',
    elements: [
      { id: 'e1', kind: 'radio', label: '41', value: '', checked: false, advances: false },
      { id: 'e2', kind: 'radio', label: '42', value: '', checked: false, advances: false },
      { id: 'e3', kind: 'button', label: 'Submit and next', value: '', advances: true },
    ],
  };
  const task = 'Complete all ten practice questions, including coding questions, then submit and go next until the results page.';
  const signal = AbortSignal.timeout(180000);
  expect(await converse('Which option is correct and why?', page, [], null, signal)).toMatchObject({ kind: 'answer' });
  expect(await converse('Fill the correct option but do not submit.', page, [], null, signal)).toMatchObject({ kind: 'task', autoSubmit: false });
  expect(await converse('Complete all ten questions, submit each and go next until results.', page, [], null, signal)).toMatchObject({ kind: 'task', autoSubmit: true });
  expect(await converse('Yes, submit it.', page, [], 'Submit and next', signal)).toMatchObject({ kind: 'approve' });
  expect(await plan(task, page, [], signal)).toMatchObject({ kind: 'click', target: 'e2' });
  const code = await plan(task, { ...page, text: 'Question 10 of 10. In JavaScript, write a complete function answer() that returns the number 42.', elements: [{ id: 'code', kind: 'code', label: 'JavaScript code editor', value: 'function answer() {}', advances: false }, page.elements[2]!] }, [], signal);
  expect(code).toMatchObject({ kind: 'type', target: 'code' });
  if (code.kind !== 'type') throw new Error('Expected a typing action');
  expect(code.text).toMatch(/function\s+answer\s*\(/);
  expect(code.text).toMatch(/return\s+42/);
  expect(await plan(task, { ...page, text: 'Results: 10 of 10 questions completed. Your practice is finished.', elements: [] }, [], signal)).toMatchObject({ kind: 'done' });
}, 180000);
