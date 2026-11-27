import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from '../logger';

export function findFile(dir: string, test: (name: string) => boolean, depth = 3): string | null {
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

async function alive(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

/** A child process Doing owns, started on demand and stopped with the app. Never listens beyond 127.0.0.1. */
abstract class ManagedServer {
  protected child: ChildProcess | null = null;
  private starting: Promise<{ ok: boolean; error: string | null }> | null = null;

  constructor(
    protected readonly log: Logger,
    readonly name: string,
    private readonly healthUrl: string,
    private readonly startTimeoutMs: number,
  ) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async isUp(): Promise<boolean> {
    return alive(this.healthUrl, 800);
  }

  protected abstract command(): { exe: string; args: string[]; env?: NodeJS.ProcessEnv; logFile?: string } | { error: string };

  ensure(): Promise<{ ok: boolean; error: string | null }> {
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<{ ok: boolean; error: string | null }> {
    if (await alive(this.healthUrl)) return { ok: true, error: null };
    const cmd = this.command();
    if ('error' in cmd) return { ok: false, error: cmd.error };
    this.stop();
    const t0 = performance.now();
    let fd: number | null = null;
    try {
      if (cmd.logFile) {
        mkdirSync(dirname(cmd.logFile), { recursive: true });
        fd = openSync(cmd.logFile, 'w');
      }
    } catch {
      fd = null;
    }
    const child = spawn(cmd.exe, cmd.args, { cwd: dirname(cmd.exe), windowsHide: true, env: cmd.env ?? process.env, stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'] });
    if (fd !== null) closeSync(fd);
    this.child = child;
    child.on('error', (err) => this.log.warn(`${this.name} failed to start`, { error: err.message }));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.log.info(`${this.name} exited`, { code });
    });
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return { ok: false, error: `${this.name} stopped right after starting (code ${child.exitCode})` };
      if (await alive(this.healthUrl, 800)) {
        this.log.info(`${this.name} ready`, { ms: Math.round(performance.now() - t0) });
        return { ok: true, error: null };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, error: `${this.name} did not start within ${Math.round(this.startTimeoutMs / 1000)} s` };
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}

/** whisper.cpp's HTTP server (live transcription). */
export class WhisperServer extends ManagedServer {
  files: { exe: string; model: string; threads: number } | null = null;

  constructor(log: Logger, private readonly port = 8178) {
    super(log, 'Speech recognition', `http://127.0.0.1:${port}/`, 30_000);
  }

  protected command() {
    if (!this.files) return { error: 'Speech recognition is not installed yet.' };
    const threads = this.files.threads > 0 ? this.files.threads : Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));
    return {
      exe: this.files.exe,
      args: ['-m', this.files.model, '--host', '127.0.0.1', '--port', String(this.port), '-t', String(threads), '-nt', '-l', 'auto'],
    };
  }
}

/**
 * Doing's own Ollama server on a private loopback port. Two parallel slots let the short
 * "is this a question for me?" check run while an answer is being written.
 */
export class OllamaServer extends ManagedServer {
  exe: string | null = null;
  logFile: string | null = null;
  /** Always passed explicitly, so Doing's server and a user's own Ollama agree on where models are. */
  modelsDir: string | null = null;
  /** Tokens per answer slot; null leaves Ollama's default (4K). */
  contextLength: number | null = null;

  constructor(log: Logger, private readonly port: number) {
    super(log, 'Answer engine', `http://127.0.0.1:${port}/api/version`, 60_000);
  }

  protected command() {
    if (!this.exe) return { error: 'The answer engine is not installed yet.' };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${this.port}`,
      OLLAMA_NUM_PARALLEL: process.env.DOING_ENGINE_PARALLEL ?? '2',
      OLLAMA_MAX_LOADED_MODELS: '1',
    };
    if (this.modelsDir) env.OLLAMA_MODELS = this.modelsDir;
    if (this.contextLength) env.OLLAMA_CONTEXT_LENGTH = String(this.contextLength);
    // Tests measure a PC without a GPU this way. Hiding CUDA alone is not enough: Ollama then
    // runs on the same card through Vulkan.
    if (process.env.DOING_ENGINE_FORCE_CPU === '1') {
      env.CUDA_VISIBLE_DEVICES = '-1';
      env.GGML_VK_VISIBLE_DEVICES = '-1';
      env.HIP_VISIBLE_DEVICES = '-1';
      env.ROCR_VISIBLE_DEVICES = '-1';
    }
    return { exe: this.exe, args: ['serve'], env, logFile: this.logFile ?? undefined };
  }
}
