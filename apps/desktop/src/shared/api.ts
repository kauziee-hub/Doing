import type { IpcChannel, IpcRequest, IpcResponses, LiveEvent } from '@doing/contracts';

interface Bridge {
  invoke(channel: IpcChannel, payload?: unknown): Promise<unknown>;
  onLive(cb: (ev: LiveEvent) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}

declare global {
  interface Window {
    doing: Bridge;
  }
}

/** Typed wrapper over the preload bridge. */
export function invoke<C extends IpcChannel>(channel: C, ...payload: IpcRequest<C> extends void ? [] : [IpcRequest<C>]): Promise<IpcResponses[C]> {
  return window.doing.invoke(channel, payload[0]) as Promise<IpcResponses[C]>;
}

export function onLive(cb: (ev: LiveEvent) => void): () => void {
  return window.doing.onLive(cb);
}

export function pathForFile(file: File): string {
  return window.doing.pathForFile(file);
}

/** Epoch-based high-resolution timestamp comparable with the main process clock. */
export function nowEpoch(): number {
  return performance.timeOrigin + performance.now();
}

/** Reports when a frame containing an update has actually been painted. */
export function reportPaint(token: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void invoke('overlay:reportPaint', { token, at: nowEpoch() }).catch(() => undefined);
    });
  });
}
