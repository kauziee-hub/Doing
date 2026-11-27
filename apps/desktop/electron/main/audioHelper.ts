import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { AudioSource } from '@doing/contracts';
import type { Logger } from './logger';

export const HEADER_LEN = 24;
const KIND_AUDIO = 1;
const KIND_EVENT = 2;
const MAX_PAYLOAD = 4 * 1024 * 1024;

export interface DecodedFrame {
  kind: number;
  source: AudioSource | 'none';
  flags: number;
  seq: number;
  timestampUs: number;
  payload: Buffer;
}

const SOURCE_BY_ID: Array<AudioSource | 'none'> = ['none', 'mic', 'system', 'app'];

/** Incremental decoder for the helper's framed stdout protocol (see native/windows-audio/src/protocol.rs). */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: DecodedFrame[] = [];
    let off = 0;
    while (this.buf.length - off >= HEADER_LEN) {
      if (this.buf[off] !== 0x56 || this.buf[off + 1] !== 0x43) throw new Error('audio helper protocol desync (bad magic)');
      if (this.buf[off + 2] !== 1) throw new Error(`unsupported helper protocol version ${this.buf[off + 2]}`);
      const len = this.buf.readUInt32LE(off + 20);
      if (len > MAX_PAYLOAD) throw new Error('audio helper frame too large');
      if (this.buf.length - off < HEADER_LEN + len) break;
      out.push({
        kind: this.buf[off + 3]!,
        source: SOURCE_BY_ID[this.buf[off + 4]!] ?? 'none',
        flags: this.buf[off + 5]!,
        seq: this.buf.readUInt32LE(off + 8),
        timestampUs: Number(this.buf.readBigUInt64LE(off + 12)),
        payload: this.buf.subarray(off + HEADER_LEN, off + HEADER_LEN + len),
      });
      off += HEADER_LEN + len;
    }
    this.buf = off === this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(off));
    return out;
  }
}

export interface HelperEvent {
  type: string;
  [k: string]: unknown;
}

export interface HelperStatsSnapshot {
  ipcSeqGaps: Record<string, number>;
  framesReceived: Record<string, number>;
  restarts: number;
}

/**
 * Owns the long-lived native audio helper process. Restarts it (bounded) if it
 * crashes. Emits: 'frame' (source, pcm, flags, timestampUs), 'event' (HelperEvent),
 * 'ready', 'exit'.
 */
export class AudioHelper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private decoder = new FrameDecoder();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private shuttingDown = false;
  private restartTimes: number[] = [];
  private lastSeq = new Map<string, number>();
  readonly stats: HelperStatsSnapshot = { ipcSeqGaps: {}, framesReceived: {}, restarts: 0 };
  version: string | null = null;
  lastError: string | null = null;
  startEpochMs = 0;

  constructor(
    readonly exePath: string | null,
    private readonly log: Logger,
  ) {
    super();
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  start(): boolean {
    if (this.running) return true;
    if (!this.exePath || !existsSync(this.exePath)) {
      this.lastError = 'Native audio helper not found. Run `pnpm native:build` (development) or reinstall Doing.';
      this.log.error('audio helper missing', { path: this.exePath });
      return false;
    }
    this.decoder = new FrameDecoder();
    this.lastSeq.clear();
    const proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => {
      let frames: DecodedFrame[];
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        this.lastError = (err as Error).message;
        this.log.error('helper decode failure', { error: this.lastError });
        proc.kill();
        return;
      }
      for (const f of frames) this.dispatch(f);
    });
    proc.stderr.on('data', (d: Buffer) => this.log.warn('helper stderr', { text: d.toString('utf8').slice(0, 500) }));
    proc.on('error', (err) => {
      this.lastError = err.message;
      this.log.error('helper spawn error', { error: err.message });
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('audio helper exited'));
      }
      this.pending.clear();
      this.emit('exit', code, signal);
      if (this.shuttingDown) return;
      this.lastError = `Audio helper exited (code ${code ?? signal})`;
      this.log.error('helper exited unexpectedly', { code, signal });
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
      if (this.restartTimes.length < 5) {
        this.restartTimes.push(now);
        this.stats.restarts++;
        setTimeout(() => {
          if (!this.shuttingDown && this.start()) this.emit('restarted');
        }, 500 * this.restartTimes.length);
      }
    });
    this.log.info('audio helper started', { pid: proc.pid });
    return true;
  }

  private dispatch(f: DecodedFrame): void {
    if (f.kind === KIND_AUDIO && f.source !== 'none') {
      const last = this.lastSeq.get(f.source);
      if (last !== undefined && f.seq !== last + 1) this.stats.ipcSeqGaps[f.source] = (this.stats.ipcSeqGaps[f.source] ?? 0) + 1;
      this.lastSeq.set(f.source, f.seq);
      this.stats.framesReceived[f.source] = (this.stats.framesReceived[f.source] ?? 0) + 1;
      this.emit('frame', f.source, f.payload, f.flags, f.timestampUs);
      return;
    }
    if (f.kind !== KIND_EVENT) return;
    let ev: HelperEvent;
    try {
      ev = JSON.parse(f.payload.toString('utf8')) as HelperEvent;
    } catch {
      return;
    }
    if (ev.type === 'response') {
      const id = ev.id as number;
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (ev.ok) p.resolve(ev.data);
        else p.reject(new Error(String(ev.error ?? 'helper error')));
      }
      return;
    }
    if (ev.type === 'hello') {
      this.version = String(ev.version ?? '');
      this.startEpochMs = Number(ev.startEpochMs ?? 0);
      this.lastError = null;
      this.emit('ready', ev);
    }
    this.emit('event', ev);
  }

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 6000): Promise<T> {
    if (!this.running) {
      if (!this.start()) return Promise.reject(new Error(this.lastError ?? 'audio helper unavailable'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`audio helper timeout (${cmd})`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.running) return;
    try {
      await this.request('shutdown', {}, 1500);
    } catch {
      /* fall through to kill */
    }
    setTimeout(() => this.proc?.kill(), 500).unref();
  }
}
