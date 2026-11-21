import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, LIVE_EVENT_CHANNEL } from '@hirora/contracts';
import type { IpcChannel, LiveEvent } from '@hirora/contracts';

const allowed = new Set<string>(IPC_CHANNELS);

/**
 * The only surface the sandboxed renderer can reach. No Node APIs, no raw
 * ipcRenderer, no secrets: just allowlisted invoke channels (validated again in
 * main with Zod) and one push channel for live events.
 */
const api = {
  async invoke(channel: IpcChannel, payload?: unknown): Promise<unknown> {
    if (!allowed.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
    const res = (await ipcRenderer.invoke(channel, payload)) as { ok: boolean; data?: unknown; error?: string };
    if (!res || !res.ok) throw new Error(res?.error ?? 'IPC failure');
    return res.data;
  },
  onLive(cb: (ev: LiveEvent) => void): () => void {
    const listener = (_e: unknown, ev: LiveEvent) => cb(ev);
    ipcRenderer.on(LIVE_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(LIVE_EVENT_CHANNEL, listener);
  },
  /** Resolve a dropped File to its path (Electron ≥32 replacement for File.path). */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('hirora', api);

export type HiroraApi = typeof api;
