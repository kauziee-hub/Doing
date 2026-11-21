import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from './logger';

/** Where the optional local-Whisper files live (whisper.cpp CUDA build + a ggml model). */
export function localWhisperDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'Hirora', 'whisper');
}

function findFile(dir: string, test: (name: string) => boolean, depth = 3): string | null {
  if (!existsSync(dir) || depth < 0) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const hit = findFile(p, test, depth - 1);
      if (hit) return hit;
    } else if (test(name)) return p;
  }
  return null;
}

/** whisper-server.exe and the best model present, or null when not installed. */
export function findLocalWhisper(root = localWhisperDir()): { exe: string; model: string } | null {
  const exe = findFile(join(root, 'bin'), (n) => n.toLowerCase() === 'whisper-server.exe');
  const models = join(root, 'models');
  if (!exe || !existsSync(models)) return null;
  const bins = readdirSync(models).filter((n) => /^ggml-.*\.bin$/i.test(n));
  const pick = bins.find((n) => /large-v3-turbo/i.test(n)) ?? bins.find((n) => /small|base/i.test(n)) ?? bins[0];
  return pick ? { exe, model: join(models, pick) } : null;
}

async function alive(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.text();
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs whisper.cpp's HTTP server on loopback while "Whisper on this PC" is selected.
 * Reuses a server that is already answering on the port; never exposes it beyond 127.0.0.1.
 */
export class LocalWhisperServer {
  private child: ChildProcess | null = null;
  private starting: Promise<{ ok: boolean; error: string | null }> | null = null;

  constructor(private readonly log: Logger) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  ensure(url: string): Promise<{ ok: boolean; error: string | null }> {
    this.starting ??= this.start(url).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(url: string): Promise<{ ok: boolean; error: string | null }> {
    if (await alive(url)) return { ok: true, error: null };
    const files = findLocalWhisper();
    if (!files) return { ok: false, error: `Local Whisper files not found in ${localWhisperDir()}` };
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return { ok: false, error: 'Local Whisper must listen on 127.0.0.1' };
    this.stop();
    const args = ['-m', files.model, '--host', '127.0.0.1', '--port', u.port || '8178', '-t', '4', '-nt', '-l', 'auto'];
    const t0 = performance.now();
    const child = spawn(files.exe, args, { cwd: dirname(files.exe), windowsHide: true, stdio: 'ignore' });
    this.child = child;
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.log.info('local whisper exited', { code });
    });
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) return { ok: false, error: `Local Whisper exited (code ${child.exitCode})` };
      if (await alive(url, 800)) {
        this.log.info('local whisper ready', { ms: Math.round(performance.now() - t0), model: files.model.split(/[\\/]/).pop() });
        return { ok: true, error: null };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: 'Local Whisper did not start within 15 s' };
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}
