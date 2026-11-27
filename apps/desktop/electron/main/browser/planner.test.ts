import { expect, it } from 'vitest';
import { browserActionSchema } from './planner';
import type { BrowserSnapshot } from '@doing/contracts';

it('constrains clicks to available controls and prevents repeating a selected radio', () => {
  const page: BrowserSnapshot = {
    revision: 'test',
    url: 'https://practice.example',
    title: 'Practice',
    text: 'Question 1 of 10',
    elements: [
      { id: 'answer', kind: 'radio', label: 'Answer', checked: true, value: '', advances: false },
      { id: 'next', kind: 'button', label: 'Next', value: '', advances: true },
    ],
  };
  const schema = browserActionSchema(page);
  const variants = (schema.oneOf ?? schema.anyOf) as Array<{ properties: { kind: { const: string }; target?: { enum: string[] } } }>;
  expect(variants.find((v) => v.properties.kind.const === 'click')?.properties.target?.enum).toEqual(['next']);
  expect(variants.some((v) => ['type', 'select', 'switch'].includes(v.properties.kind.const))).toBe(false);
  const batch = browserActionSchema(page, 'Answer all questions and submit each until results.');
  const pending = (batch.oneOf ?? batch.anyOf) as typeof variants;
  expect(pending.some((v) => v.properties.kind.const === 'done')).toBe(false);
  expect(variants.some((v) => v.properties.kind.const === 'done')).toBe(true);
});

it('offers only different explicitly allowed tabs for switching', () => {
  const page: BrowserSnapshot = {
    revision: 'test',
    url: 'https://practice.example',
    title: 'Practice',
    text: '',
    tabId: 'one',
    elements: [],
    tabs: [
      { id: 'one', title: 'Practice', url: 'https://practice.example', text: '' },
      { id: 'two', title: 'Notes', url: 'https://notes.example', text: '' },
    ],
  };
  const schema = browserActionSchema(page);
  const variants = (schema.oneOf ?? schema.anyOf) as Array<{ properties: { kind: { const: string }; tab?: { enum: string[] } } }>;
  expect(variants.find((v) => v.properties.kind.const === 'switch')?.properties.tab?.enum).toEqual(['two']);
});
