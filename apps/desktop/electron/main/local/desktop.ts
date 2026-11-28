import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { isAdminApp } from './pc';
import { requestsMessageSend } from './messaging';

export const DesktopActionSchema = z.object({
  kind: z.literal('app_action'),
  target: z.string().min(1).max(80),
  action: z.enum(['click', 'type', 'scroll_down', 'scroll_up', 'enter']),
  text: z.string().max(4000).optional(),
});
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export interface DesktopControl {
  id: string; name: string; type: string; value: string; actions: string[];
  runtime?: string;
  nativeName?: string;
  context?: string;
}
export interface DesktopView {
  handle: string; processId: number; process: string; title: string; controls: DesktopControl[];
  revision?: string;
}
export interface DesktopHost {
  inspect(name: string, signal: AbortSignal): Promise<DesktopView>;
  act(view: DesktopView, control: DesktopControl, action: DesktopAction, signal: AbortSignal): Promise<DesktopView>;
}

export function checkDesktopAction(action: DesktopAction, view: DesktopView, request: string): DesktopControl {
  const control = view.controls.find(c => c.id === action.target);
  if (!control || !control.actions.includes(action.action)) throw new Error('That app control changed. Read the app again before acting.');
  const label = `${control.name} ${control.type}`;
  if (/^(?:close|minimize|maximize|restore)\b/i.test(control.name) && !/\b(?:close|minimize|maximize|restore)\b/i.test(request))
    throw new Error('Changing this window was not requested. No action was taken.');
  if (!action.action.startsWith('scroll_') && /^(?:what|why|how|explain|describe|summari[sz]e|read|tell me about)\b/i.test(request.trim()))
    throw new Error('This is a question about the app. No control was changed.');
  if (/password|passcode|credit.card|payment|purchase|buy now|checkout|permanently|format drive|reset.*pc|uninstall|install now|security|firewall|defender/i.test(label))
    throw new Error('Complete this sensitive action yourself in the app.');
  if (/\b(delete|remove|trash)\b/i.test(label)) throw new Error('Use a file task to move the exact item to the Recycle Bin.');
  const sending = (action.action !== 'type' && /\b(send|post|publish|submit|apply|confirm|save)\b/i.test(label)) || (action.action === 'enter' && !/search|find/i.test(control.name));
  if (sending && !requestsMessageSend(request))
    throw new Error('This action can send or save. Tell me explicitly to send, submit or save it first.');
  if (action.action === 'type' && action.text === undefined) throw new Error('Typing requires the requested text.');
  return control;
}

/** Fixed accessibility helper. Model strings are data in an environment variable, never executable code. */
export function createDesktopHost(script: string): DesktopHost {
  let observationId = 0;
  const labels=new Map<string,string>();
  const run = (arg: unknown, signal: AbortSignal): Promise<DesktopView> => new Promise((resolve, reject) => {
    const taskArg=arg as {name?:string;process?:string};
    const modern=/^WhatsApp(?:\.|$)/i.test(taskArg.name??'') || /^WhatsApp(?:\.|$)/i.test(taskArg.process??'') || script.endsWith('desktop-control-uia3.ps1');
    const helper=modern?join(dirname(script),'desktop-control-uia3.ps1'):script;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
      env: { ...process.env, DOING_DESKTOP_ARG: JSON.stringify(arg) }, windowsHide: true,
      timeout: modern?60_000:25_000, maxBuffer: 1 << 20, encoding: 'utf8', signal,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim().slice(0, 400)));
      try {
        const view = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as DesktopView;
        if (!Array.isArray(view.controls) || !view.handle || !view.process || !view.processId) throw new Error('Invalid app observation.');
        if (isAdminApp(view.process) || /^(?:Doing|electron|chrome|msedge|firefox|brave|opera|ApplicationFrameHost)$/i.test(view.process))
          throw new Error('Use Browser chat for browsers. System tools and Doing itself are outside app control.');
        const prefix = `d${++observationId}`;
        view.controls = view.controls.map((c, i) => {
          const key=JSON.stringify([view.handle,view.processId,c.runtime,c.type]);
          if(c.name && c.runtime)labels.set(key,c.name);
          const label=c.runtime?labels.get(key):undefined;
          return {...c,id:`${prefix}e${i}`,...(!c.name&&label?{nativeName:c.name,name:label}:{})};
        });
        if(labels.size>600){const recent=[...labels.entries()].slice(-300);labels.clear();for(const [key,value]of recent)labels.set(key,value);}
        resolve(view);
      } catch (e) { reject(e); }
    });
  });
  return {
    inspect: (name, signal) => run({ name }, signal),
    act: (view, control, action, signal) => run({ handle: view.handle, processId: view.processId, process: view.process, revision: view.revision, runtime: control.runtime, context: control.context, name: control.nativeName ?? control.name, type: control.type, action: action.action, text: action.text }, signal),
  };
}

export function modelDesktopView(view: DesktopView): string {
  const controls: Omit<DesktopControl, 'runtime'>[] = [];
  let chars = 0;
  for (const c of view.controls) {
    const clean = { id: c.id, name: c.name.slice(0, 160), type: c.type.replace('ControlType.', ''), value: c.value.slice(0, 4000), context: c.context?.slice(0, 350), actions: c.actions };
    const size = JSON.stringify(clean).length;
    if (chars + size > 10000) break;
    controls.push(clean); chars += size;
  }
  return JSON.stringify({ app: view.process, title: view.title, controls, omitted: controls.length < view.controls.length });
}
