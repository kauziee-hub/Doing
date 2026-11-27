import { z } from 'zod';

export const BrowserElementSchema = z.object({
  id: z.string().max(80),
  kind: z.enum(['button', 'link', 'text', 'checkbox', 'radio', 'select', 'code']),
  label: z.string().max(600),
  value: z.string().max(12_000).default(''),
  checked: z.boolean().optional(),
  group: z.string().max(80).optional(),
  options: z
    .array(z.object({ value: z.string().max(300), label: z.string().max(300) }))
    .max(100)
    .optional(),
  advances: z.boolean().default(false),
});
export const BrowserSnapshotSchema = z.object({
  revision: z.string().max(80),
  url: z.string().url().max(2048),
  title: z.string().max(300),
  text: z.string().max(18_000),
  elements: z.array(BrowserElementSchema).max(180),
  tabId: z.string().max(80).optional(),
  tabs: z
    .array(z.object({ id: z.string().max(80), url: z.string().url().max(2048), title: z.string().max(300), text: z.string().max(2500) }))
    .max(8)
    .optional(),
});
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), reason: z.string().min(1).max(500), target: z.string().max(80) }),
  z.object({ kind: z.literal('type'), target: z.string().max(80), text: z.string().max(12_000), reason: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('select'), target: z.string().max(80), value: z.string().max(300), reason: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('wait'), reason: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('done'), reason: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('ask'), reason: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('switch'), tab: z.string().min(1).max(80), reason: z.string().min(1).max(500) }),
]);
export const BrowserStartSchema = z.object({
  task: z.string().trim().min(1).max(6000),
  consent: z.literal(true),
  autoSubmit: z.boolean(),
  maxSteps: z.number().int().min(1).max(300).default(150),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type BrowserStart = z.infer<typeof BrowserStartSchema>;
export interface BrowserCommand {
  id: string;
  runId: string;
  revision: string;
  origin: string;
  action: BrowserAction;
}
export interface BrowserStatus {
  enabled: boolean;
  pairingCode: string | null;
  trustedBrowser: boolean;
  connectionRequest: { id: string; label: string; extensionId: string } | null;
  port: number;
  phase: 'off' | 'disconnected' | 'ready' | 'running' | 'review' | 'done' | 'stopped' | 'error';
  tab: { title: string; url: string } | null;
  pageReady: boolean;
  tabs: Array<{ id: string; url: string; title: string }>;
  messages: BrowserChatMessage[];
  chatting: boolean;
  task: string;
  autoSubmit: boolean;
  steps: number;
  maxSteps: number;
  message: string;
  pending: { reason: string; label: string } | null;
  log: Array<{ at: number; message: string }>;
}
export interface BrowserChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}
