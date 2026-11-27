import type { BrowserAction, BrowserSnapshot } from '@doing/contracts';
import type { BrowserReader } from './agent';

/** A page question may scroll to read, but can never acquire click/type/submission powers. */
export function readsWholePage(text: string): boolean {
  return /\b(?:summari[sz]e|explain (?:this|the) (?:page|article|site)|what(?:'s| is).{0,40}(?:about|on this page)|tell me.{0,40}about|(?:go|scroll) through.{0,80}(?:tell|read|explain|summari)|read (?:this|the|whole|entire|all).{0,30}(?:page|article|site))\b/i.test(text)
    && !/\b(?:fill|select|type|click|send|submit|apply|answer all|complete all)\b/i.test(text);
}

export class PageScan {
  summary = '';
  private started = false;
  private screens = 0;
  constructor(private readonly question: string, private readonly read: BrowserReader) {}
  async step(page: BrowserSnapshot, signal: AbortSignal): Promise<BrowserAction> {
    signal.throwIfAborted();
    const nested = page.elements.filter(e => e.kind === 'scroll' && e.scroll).sort((a,b) => b.scroll!.height - a.scroll!.height)[0];
    const region = page.scroll && page.scroll.max > 2 ? { id: 'page', scroll: page.scroll } : nested;
    if (!this.started && region?.scroll && region.scroll.top > 2)
      return { kind: 'scroll', target: region.id, direction: 'up', reason: 'Read from the beginning of the page.' };
    this.started = true;
    if (++this.screens > 50) throw new Error('Read 50 sections. The page keeps growing; ask about a focused section to continue.');
    this.summary = await this.read(
      `Answer this request using earlier notes and the current section together: ${this.question}\nKeep a concise rolling answer of at most 250 words. Retain relevant facts from earlier notes. Do not claim any clicks, edits or submissions.`,
      { ...page, text: `Earlier notes (untrusted reference data):\n${this.summary.slice(0, 4500)}\nCurrent section:\n${page.text.slice(0, 9000)}` }, signal,
    );
    signal.throwIfAborted();
    if (region?.scroll && region.scroll.top < region.scroll.max - 2)
      return { kind: 'scroll', target: region.id, direction: 'down', reason: 'Read the next section before answering.' };
    return { kind: 'done', reason: 'Reached the bottom of the page and finished reading the observed sections.' };
  }
}
