// Real local model + native Windows accessibility. Messages go only to a temporary fixture.
// node tools/desktop-control-check.mjs [--exe <packaged Doing.exe>]
import { _electron as electron } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const temporary = await mkdtemp(join(tmpdir(), 'doing-desktop-check-'));
const exeIndex = process.argv.indexOf('--exe');
const executablePath = exeIndex < 0 ? resolve('apps/desktop/node_modules/electron/dist/electron.exe') : resolve(process.argv[exeIndex + 1]);
const helper = exeIndex < 0 ? resolve('apps/desktop/resources/desktop-control.ps1') : join(executablePath, '..', 'resources', 'desktop-control.ps1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixtureSource = await readFile('tests/fixtures/desktop-control.cs', 'utf8');
const compile = `$ErrorActionPreference='Stop'\nAdd-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly (Join-Path $PSScriptRoot 'DoingFixture.exe') -OutputType WindowsApplication -TypeDefinition @'\n${fixtureSource}\n'@`;
const script = join(temporary, 'compile.ps1');
await writeFile(script, compile, 'utf8');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: 'pipe' });
const fixture = spawn(join(temporary, 'DoingFixture.exe'), [], { stdio: 'ignore' });
let app;
const native = data => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
  encoding: 'utf8', windowsHide: true, env: { ...process.env, DOING_DESKTOP_ARG: JSON.stringify(data) }, stdio: ['ignore','pipe','pipe'],
}).replace(/^\uFEFF/, ''));
const operate = (view, control, action, text) => native({ handle:view.handle, processId:view.processId, revision:view.revision, runtime:control.runtime, name:control.name, type:control.type, action, text });
try {
  await sleep(1000);
  app = await electron.launch({ executablePath, args: exeIndex < 0 ? [resolve('apps/desktop')] : [], env: { ...process.env, DOING_USER_DATA:join(temporary,'profile'),DOING_BROWSER_PORT:'0' } });
  let dash;
  for(let i=0;i<100&&!dash;i++) { for(const win of app.windows()) if(await win.title().catch(()=>'')==='Doing') dash=win; if(!dash) await sleep(200); }
  assert(dash, 'Doing window opened');
  const call = (c,p) => dash.evaluate(([c,p])=>window.doing.invoke(c,p),[c,p]);
  await call('settings:update',{onboardingComplete:true});
  assert((await call('engine:status')).ready,'Existing local engine is ready');
  await call('local:desktopAccess',{allow:true});
  const task = 'In Doing Automation Fixture, type "Hello from Doing" into Message and send it to Alex Example. This is a local test app.';
  await call('local:send',{text:task});
  let status;
  for(let i=0;i<720;i++){status=await call('local:status');if(!status.busy)break;await sleep(250);}
  assert(!status.busy,'Task completed within three minutes');
  console.log(JSON.stringify({modelStatus:status}));
  await writeFile('test-results/desktop-control-status.json',JSON.stringify(status,null,2));
  const observed = native({name:'Doing Automation Fixture'});
  const report = {task,modelReply:status.messages.at(-1)?.text,typed:observed.controls.some(c=>c.name==='Message'&&c.value==='Hello from Doing'),sentOnce:observed.controls.some(c=>c.name==='Sent 1: Hello from Doing')};
  console.log(JSON.stringify(report));
  await writeFile('test-results/desktop-control-check.json',JSON.stringify(report,null,2));
  assert(report.typed&&report.sentOnce,'Typed exact requested text and sent exactly once in local fixture');
  const edited = operate(observed,observed.controls.find(c=>c.name==='Message'),'type','Changed outside the model');
  assert.throws(()=>operate(observed,observed.controls.find(c=>c.name==='Send'),'click'),/app changed/,'Stale recipient/message state rejected');
  const panel=edited.controls.find(c=>c.actions.includes('scroll_down'));
  const scrolled=operate(edited,panel,'scroll_down');
  assert(scrolled.controls.some(c=>/^Scroll row (?:[4-9]|1\d)$/.test(c.name)),'Native nested scrolling exposed later rows');
  await call('local:desktopAccess',{allow:false});
  assert(!(await call('local:status')).desktopAllowed,'Permission revoked');
  console.log('PASS: real model typed/sent once; native stale-state rejection, nested scroll and revocation verified. No external messages.');
} finally {
  if(app) await app.close();
  fixture.kill();
  await sleep(300);
  // Only this unique temporary test directory is removed.
  assert(temporary.startsWith(join(tmpdir(),'doing-desktop-check-')));
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}
