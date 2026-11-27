import type { BrowserSnapshot } from '@doing/contracts';

export const usesOtherTabs = (text: string) => /\b(?:group|both tabs|all tabs|other tab|across.{0,20}tabs|between.{0,20}tabs)\b/i.test(text);

/** Keep whole controls and valid JSON, with bounded screen text and no unrelated tab contents. */
export function modelPage(page: BrowserSnapshot, budget: number, multiTab = false): BrowserSnapshot {
  const result: BrowserSnapshot = {
    ...page,
    text: page.text,
    elements: page.elements.map((el) => ({ ...el, label: el.label.slice(0, 180), value: el.kind === 'code' ? el.value : el.value.slice(0, 1000) })),
    tabs: page.tabs?.map((tab) => ({ ...tab, text: multiTab ? tab.text.slice(0, 500) : '' })),
  };
  const size = () => JSON.stringify(result).length;
  result.text = result.text.slice(0, Math.max(0, result.text.length - Math.max(0, size() - budget)));
  while (size() > budget && result.elements.length > 1) result.elements.pop();
  if (size() > budget) throw new Error('This editor is too large for the local model. Use a smaller editable section.');
  return result;
}
