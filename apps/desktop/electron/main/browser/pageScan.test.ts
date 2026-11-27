import { expect, it, vi } from 'vitest';
import { PageScan, readsWholePage } from './pageScan';
import type { BrowserSnapshot } from '@doing/contracts';

const page = (top: number, max: number, text = 'Section'): BrowserSnapshot => ({ url:'https://example.org/', title:'Article', revision:'r', text, elements:[], scroll:{top,max,height:800} });
it('routes whole-page explanations to a read-only scan, never form instructions', () => {
  expect(readsWholePage('Go through this page and tell me what it is about')).toBe(true);
  expect(readsWholePage('Summarize this article')).toBe(true);
  expect(readsWholePage('Fill this application and submit')).toBe(false);
  expect(readsWholePage('Summarize then fill the options')).toBe(false);
});
it('reads from the beginning, accumulates later sections and never clicks or types', async () => {
  const read = vi.fn(async (_q: string, p: BrowserSnapshot) => p.text.includes('Final detail') ? 'Includes first section and final detail.' : 'First section.');
  const scan = new PageScan('Summarize this page', read);
  const signal = new AbortController().signal;
  expect(await scan.step(page(400,800),signal)).toMatchObject({kind:'scroll',direction:'up'});
  expect(read).not.toHaveBeenCalled();
  expect(await scan.step(page(0,800,'First section'),signal)).toMatchObject({kind:'scroll',direction:'down'});
  expect(await scan.step(page(800,800,'Final detail'),signal)).toMatchObject({kind:'done'});
  expect(read.mock.calls[1]![1].text).toContain('First section.');
  expect(scan.summary).toContain('final detail');
});
it('scans nested scroll regions and stops on abort', async () => {
  const read = vi.fn(async () => 'A section');
  const scan = new PageScan('Read this page',read);
  const p = page(0,0); p.elements = [{id:'panel',kind:'scroll',label:'Article',value:'',advances:false,scroll:{top:0,max:1000,height:500}}];
  expect(await scan.step(p,new AbortController().signal)).toMatchObject({kind:'scroll',target:'panel'});
  const c = new AbortController(); c.abort();
  await expect(scan.step(p,c.signal)).rejects.toBeDefined();
});
