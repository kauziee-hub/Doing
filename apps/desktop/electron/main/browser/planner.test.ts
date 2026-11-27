import { modelPage } from './context';
import { checkAction } from './agent';
import { expect, it } from 'vitest';
import { browserActionSchema, selectionAction, questionSelectionSchema } from './planner';
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

it('fits large page contexts without unrelated tab contents or malformed control JSON', () => {
 const source:BrowserSnapshot={revision:'r',url:'https://example.test',title:'Long',text:'Question text '.repeat(1300),elements:Array.from({length:180},(_,i)=>({id:`e${i}`,kind:'radio' as const,label:'Option '.repeat(80),value:'',advances:false})),tabs:[{id:'mail',url:'https://mail.example',title:'Mail',text:'PRIVATE EMAIL CONTENT'}]};
 const result=modelPage(source,6000);
 expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
 expect(JSON.stringify(result)).not.toContain('PRIVATE EMAIL CONTENT');
 expect(result.elements.length).toBeGreaterThan(1);
});
it('allows observed scrolling, rejects boundaries and enforces do-not-submit even for Check Answer',()=>{
 const page:BrowserSnapshot={revision:'r',url:'https://example.test',title:'Long',text:'Question',scroll:{top:0,max:10000,height:800},elements:[{id:'check',kind:'button',label:'Check Answer',value:'',advances:false}]};
 expect(checkAction({kind:'scroll',target:'page',direction:'down',reason:'More questions'},page)).toBeNull();
 expect(checkAction({kind:'scroll',target:'page',direction:'up',reason:'Back'},page)).toContain('boundary');
 expect(checkAction({kind:'click',target:'check',reason:'Check'},page,'Answer all and do not submit')).toContain('not to submit');
});


it('applies a complete MCQ answer set without toggling correct checked options off',()=>{
 const page:BrowserSnapshot={revision:'r',url:'https://example.test',title:'Quiz',text:'Choose two',elements:['A','B','C'].map(id=>({id,kind:'checkbox',label:id,value:'',checked:id==='A',advances:false}))};
 expect(selectionAction({targets:['A','B'],reason:'A and B'},page)).toMatchObject({kind:'click',target:'B'});
 page.elements[1]!.checked=true;
 expect(selectionAction({targets:['A','B'],reason:'A and B'},page)).toMatchObject({kind:'done'});
 page.elements[2]!.checked=true;
 expect(selectionAction({targets:['A','B'],reason:'A and B'},page)).toMatchObject({kind:'click',target:'C'});
 expect(()=>questionSelectionSchema(page).parse({kind:'choices',targets:['missing'],reason:'Invalid'})).toThrow();
});
