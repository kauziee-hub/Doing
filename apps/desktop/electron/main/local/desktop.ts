import { execFile } from 'node:child_process';
import { z } from 'zod';
import { isAdminApp } from './pc';

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
  const sending = /\b(send|post|publish|submit|apply|confirm|save)\b/i.test(label) || action.action === 'enter';
  if (sending && (!/\b(send|post|publish|submit|apply|confirm|save)\b/i.test(request) || /\b(don't|do not|dont|never|without|draft|not yet)\b/i.test(request)))
    throw new Error('This action can send or save. Tell me explicitly to send, submit or save it first.');
  if (action.action === 'type' && action.text === undefined) throw new Error('Typing requires the requested text.');
  return control;
}

/** Fixed accessibility helper. Model strings are data in an environment variable, never executable code. */
export function createDesktopHost(script: string): DesktopHost {
  let observationId = 0;
  const run = (arg: unknown, signal: AbortSignal): Promise<DesktopView> => new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, DOING_DESKTOP_ARG: JSON.stringify(arg) }, windowsHide: true,
      timeout: 25_000, maxBuffer: 1 << 20, encoding: 'utf8', signal,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim().slice(0, 400)));
      try {
        const view = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as DesktopView;
        if (!Array.isArray(view.controls) || !view.handle || !view.process || !view.processId) throw new Error('Invalid app observation.');
        if (isAdminApp(view.process) || /^(?:Doing|electron|chrome|msedge|firefox|brave|opera|ApplicationFrameHost)$/i.test(view.process))
          throw new Error('Use Browser chat for browsers. System tools and Doing itself are outside app control.');
        const prefix = `d${++observationId}`;
        view.controls = view.controls.map((c, i) => ({ ...c, id: `${prefix}e${i}` }));
        resolve(view);
      } catch (e) { reject(e); }
    });
  });
  return {
    inspect: (name, signal) => run({ name }, signal),
    act: (view, control, action, signal) => run({ handle: view.handle, processId: view.processId, revision: view.revision, runtime: control.runtime, context: control.context, name: control.name, type: control.type, action: action.action, text: action.text }, signal),
  };
}

export function modelDesktopView(view: DesktopView): string {
  const controls: Omit<DesktopControl, 'runtime'>[] = [];
  let chars = 0;
  for (const c of view.controls) {
    const clean = { id: c.id, name: c.name.slice(0, 160), type: c.type.replace('ControlType.', ''), value: c.value.slice(0, 250), actions: c.actions };
    const size = JSON.stringify(clean).length;
    if (chars + size > 10000) break;
    controls.push(clean); chars += size;
  }
  return JSON.stringify({ app: view.process, title: view.title, controls, omitted: controls.length < view.controls.length });
}
