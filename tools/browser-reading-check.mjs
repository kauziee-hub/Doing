// Real companion + local model: whole-page reading must reach the final section without editing.
import { chromium, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const temp=await mkdtemp(join(tmpdir(),'doing-page-reading-'));
const exeIndex=process.argv.indexOf('--exe');
const exe=exeIndex<0?resolve('apps/desktop/node_modules/electron/dist/electron.exe'):resolve(process.argv[exeIndex+1]);
const html='<!doctype html><title>Community garden plan</title><style>section{height:650px;font:20px system-ui;padding:20px}</style><section><h1>Community garden plan</h1><p>The project opens on 12 May. Volunteers will plant tomatoes and beans.</p><input aria-label="Do not edit" value="unchanged"></section><section><h2>Water and access</h2><p>Use collected rainwater. Accessible paths will connect all garden beds.</p></section><section><h2>Final section: budget</h2><p>The final budget is 7300 credits. The coordinator is Alex Example.</p><button onclick="window.clicks++">Submit</button></section><script>window.clicks=0;window.edits=0;document.querySelector("input").oninput=()=>window.edits++;</script>';
const server=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(html));
let app,context;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 app=await electron.launch({executablePath:exe,args:exeIndex<0?[resolve('apps/desktop')]:[],env:{...process.env,DOING_USER_DATA:join(temp,'profile'),DOING_BROWSER_PORT:'0'}});
 let dash;for(let i=0;i<100&&!dash;i++){for(const win of app.windows())if(await win.title().catch(()=>'')==='Doing')dash=win;if(!dash)await sleep(200);}
 assert(dash);
 const invoke=(c,p)=>dash.evaluate(([c,p])=>window.doing.invoke(c,p),[c,p]);
 await dash.getByRole('dialog').getByRole('button',{name:'Skip',exact:true}).click();
 const connection=await invoke('browser:status');
 const extension=join(temp,'extension');
 await cp(exeIndex<0?resolve('apps/desktop/resources/browser-extension'):join(exe,'..','resources','browser-extension'),extension,{recursive:true});
 const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
 manifest.host_permissions.push(`${origin}/*`); // Fixture-only replacement for the activeTab toolbar gesture.
 await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
 context=await chromium.launchPersistentContext(join(temp,'browser'),{headless:true,channel:'chromium',viewport:{width:1200,height:700},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const site=await context.newPage();await site.goto(origin);
 const panel=await context.newPage();await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
 await panel.waitForFunction(()=>document.getElementById('connection').textContent==='No tab shared.');
 await site.bringToFront();
 const pairing=panel.evaluate(({port})=>globalThis.chrome.runtime.sendMessage({type:'connect',port}),{port:connection.port});
 await dash.getByRole('navigation',{name:'Main'}).getByRole('button',{name:'Browser assistant',exact:true}).click();
 await dash.getByRole('region',{name:'Browser connection approval'}).getByRole('button',{name:'Allow connection & remember'}).click();
 assert(!(await pairing).error);
 await panel.getByText('Allowed pages are ready.',{exact:true}).waitFor();
 await panel.getByLabel('Message Doing').fill('Go through this whole page and tell me what it is about, including the opening date and final budget.');
 await panel.getByRole('button',{name:'Send message',exact:true}).click();
 let state;
 for(let i=0;i<600;i++){state=await invoke('browser:status');if(['done','error','stopped'].includes(state.phase)&&state.messages.length>1)break;await sleep(500);}
 const result=await site.evaluate(()=>({clicks:window.clicks,edits:window.edits,value:document.querySelector('input').value,top:scrollY,max:document.scrollingElement.scrollHeight-innerHeight}));
 const report={phase:state.phase,steps:state.steps,answer:state.messages.at(-1)?.text,...result};
 console.log(JSON.stringify(report));await writeFile('test-results/browser-reading-check.json',JSON.stringify(report,null,2));
 assert.equal(state.phase,'done');assert.equal(result.clicks,0);assert.equal(result.edits,0);assert.equal(result.value,'unchanged');
 assert(result.top>=result.max-2,'Reached the final section');
 assert(/12 May|May 12/i.test(report.answer)&&/7,?300/.test(report.answer),'Retained opening and final section details');
}finally{
 if(context)await context.close();if(app)await app.close();await new Promise(r=>server.close(r));
 assert(temp.startsWith(join(tmpdir(),'doing-page-reading-')));await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}
