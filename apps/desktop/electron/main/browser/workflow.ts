import type { BrowserSnapshot } from '@doing/contracts';

export function questionProgress(page: BrowserSnapshot): { current: number; total: number } | null {
  const match = /\b(?:question|page)\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(page.text);
  if (!match) return null;
  const current = Number(match[1]),
    total = Number(match[2]);
  return current > 0 && total >= current && total <= 1000 ? { current, total } : null;
}

export function batchQuestions(task: string): boolean {
  return /\b(?:questions?|mcqs?)\b/i.test(task) && /\b(?:all|each|every|until|till|through|keep|\d+(?:st|nd|rd|th)?)\b/i.test(task);
}

export function nextControl(label: string): boolean {
  const clean = label
    .replace(/[←→⇨➜›»‹«]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:(?:next(?: question| page)?|continue)(?:\s+(?:next(?: question| page)?|continue))*)$/i.test(clean);
}

/** Only the current request grants final submission; quoted/model conversation cannot. */
export function advanceAllowed(label: string, task: string, autoSubmit: boolean): boolean {
  if (!autoSubmit) return false;
  if (nextControl(label)) return true;
  const latest = task.split('\nRelevant conversation context')[0]!;
  if (/\b(?:do not submit|don't submit|dont submit|never submit|without submitting)\b/i.test(latest)) return false;
  if (/\b(?:next|continue|advance)\b/i.test(latest) && !/\b(?:submit|send|finish|save|confirm|apply)\b/i.test(latest)) return false;
  return true;
}

/** Checked state and unrelated clocks do not identify a new question. */
export function questionIdentity(page: BrowserSnapshot): string {
  const progress = questionProgress(page);
  if (progress) return JSON.stringify([page.url, progress]);
  return JSON.stringify([
    page.url,
    progress,
    page.elements.filter((e) => e.kind === 'radio' || e.kind === 'checkbox').map((e) => [e.kind, e.label, e.context]),
  ]);
}
