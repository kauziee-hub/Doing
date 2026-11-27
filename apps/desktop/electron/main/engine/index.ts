import '../environment';
import { containerCopy, migrateDoingDirectory } from '../doingMigration';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, EngineComponentId, EngineComponentStatus, EngineStatus, EngineTier } from '@doing/contracts';
import { ENGINE_OLLAMA_PORT } from '@doing/contracts';
import type { Logger } from '../logger';
import { ANSWER_RUNTIME, CATALOG, resolveTier } from './catalog';
import type { TierCatalog } from './catalog';
import { downloadPinned, extractZip } from './download';
import type { FetchFn } from './download';
import { OllamaServer, WhisperServer, findFile } from './servers';

export { CATALOG, ANSWER_RUNTIME, resolveTier } from './catalog';

export interface GpuInfo {
  name: string;
  vramMb: number;
  driver: string;
}

/** Reads the NVIDIA driver's own report. No NVIDIA GPU (or no driver) â†’ null. */
export function detectNvidiaGpu(): Promise<GpuInfo | null> {
  const smi = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe');
  return new Promise((resolve) => {
    execFile(existsSync(smi) ? smi : 'nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 6000 }, (err, out) => {
      if (err) return resolve(null);
      const best = String(out)
        .split(/\r?\n/)
        .map((l) => l.split(',').map((x) => x.trim()))
        .filter((p) => p.length >= 3 && Number(p[1]) > 0)
        .map((p) => ({ name: p[0]!, vramMb: Number(p[1]), driver: p[2]! }))
        .sort((a, b) => b.vramMb - a.vramMb)[0];
      resolve(best ?? null);
    });
  });
}

const ORDER: EngineComponentId[] = ['answer-runtime', 'speech-runtime', 'speech-model', 'answer-model'];
const LABELS: Record<EngineComponentId, string> = {
  'answer-runtime': 'Answer engine',
  'speech-runtime': 'Speech recognition',
  'speech-model': 'Speech model',
  'answer-model': 'Answer model',
};

export interface EngineDeps {
  log: Logger;
  settings: () => AppSettings;
  emit: (status: EngineStatus) => void;
  /** Used for downloads: Electron's net.fetch honours the system proxy. */
  fetchImpl: FetchFn;
  /** Engine files live here (default %LOCALAPPDATA%\Doing). */
  root?: string;
}

/**
 * Doing's on-PC engine (ADR 0012): checks the hardware, installs the speech and answer
 * runtimes and models on first run (verified downloads), and runs both servers on loopback.
 */
export class EngineManager {
  readonly root: string;
  readonly whisper: WhisperServer;
  readonly ollama: OllamaServer;
  private gpu: GpuInfo | null | undefined;
  private readonly gpuProbe: Promise<void>;
  private setupState: EngineStatus['setup'] = 'idle';
  private setupError: string | null = null;
  private abort: AbortController | null = null;
  private readonly live = new Map<EngineComponentId, Partial<EngineComponentStatus>>();
  private lastEmit = 0;

  constructor(private readonly deps: EngineDeps) {
    const localData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    this.root = deps.root ?? process.env.DOING_ENGINE_DIR ?? join(localData, 'Doing');
    if (!deps.root && !process.env.DOING_ENGINE_DIR) {
      // No engine here and no Hirora engine to migrate, but one left inside an app container:
      // copy it rather than downloading 6 GB again.
      const empty = !existsSync(this.root) || readdirSync(this.root).length === 0;
      if (empty && !existsSync(join(localData, 'Hirora', 'whisper'))) {
        const left = containerCopy(localData, 'Local', 'whisper');
        if (left && left.toLowerCase() !== this.root.toLowerCase()) migrateDoingDirectory(left, this.root);
      }
      migrateDoingDirectory(join(localData, 'Hirora'), this.root);
    }
    this.whisper = new WhisperServer(deps.log, this.whisperPort);
    this.ollama = new OllamaServer(deps.log, this.ollamaPort);
    this.ollama.logFile = join(this.root, 'ollama', 'server.log');
    // Probe the GPU right away: the tier (and so every model choice) depends on it.
    this.gpuProbe = detectNvidiaGpu().then((g) => {
      this.gpu = g;
      deps.log.info('engine hardware', { gpu: g?.name ?? 'none', vramMb: g?.vramMb ?? 0, tier: this.tier });
    });
  }

  /** Loopback ports; tests can move them so two engines never share a server. */
  get whisperPort(): number {
    return Number(process.env.DOING_ENGINE_WHISPER_PORT) || 8178;
  }
  get ollamaPort(): number {
    return Number(process.env.DOING_ENGINE_OLLAMA_PORT) || ENGINE_OLLAMA_PORT;
  }
  get whisperUrl(): string {
    return `http://127.0.0.1:${this.whisperPort}`;
  }
  get ollamaUrl(): string {
    return `http://127.0.0.1:${this.ollamaPort}/v1`;
  }

  get whisperDir(): string {
    return join(this.root, 'whisper');
  }
  get runtimeDir(): string {
    return join(this.root, 'ollama');
  }
  get tier(): EngineTier {
    return resolveTier(this.deps.settings().engine.tier, this.gpu ?? null);
  }
  get catalog(): TierCatalog {
    return CATALOG[this.tier];
  }
  get answerModel(): string {
    return this.catalog.answerModel.tag;
  }
  /** Whether the installed answer model can read screenshots. */
  get answerModelReadsImages(): boolean {
    return this.catalog.answerModel.vision;
  }
  get interimEveryMs(): number {
    return this.catalog.interimEveryMs;
  }

  /** Doing's own Ollama copy, if it downloaded one. */
  private get ownOllama(): string {
    return join(this.runtimeDir, 'ollama.exe');
  }

  /**
   * Where the answer model lives. With an Ollama the user installed themselves, its model folder
   * is shared (nothing downloaded twice). Otherwise models stay under Doing's own folder, so
   * removing %LOCALAPPDATA%\Doing removes everything Doing downloaded.
   */
  modelsDir(): string {
    if (process.env.DOING_ENGINE_MODELS) return process.env.DOING_ENGINE_MODELS;
    if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
    const own = join(this.root, 'models');
    if (existsSync(join(own, 'manifests'))) return own;
    const exe = this.ollamaExe();
    return exe && exe !== this.ownOllama ? join(homedir(), '.ollama', 'models') : own;
  }

  ollamaExe(): string | null {
    if (existsSync(this.ownOllama)) return this.ownOllama;
    if (process.env.DOING_ENGINE_NO_SYSTEM_OLLAMA === '1') return null;
    // An Ollama the user installed themselves works the same way; reuse its runtime.
    const system = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe');
    return existsSync(system) ? system : null;
  }

  whisperFiles(): { exe: string; model: string } | null {
    const c = this.catalog;
    const dir = join(this.whisperDir, c.speechRuntime.dir);
    const exe = findFile(dir, (n) => n.toLowerCase() === 'whisper-server.exe');
    const marker = findFile(dir, (n) => n.toLowerCase() === c.speechRuntime.marker.toLowerCase());
    const model = join(this.whisperDir, 'models', c.speechModel.file);
    const modelOk = existsSync(model) && statSync(model).size === c.speechModel.bytes;
    return exe && marker && modelOk ? { exe, model } : null;
  }

  private answerModelOnDisk(): boolean {
    const [name, tag] = this.answerModel.split(':');
    return existsSync(join(this.modelsDir(), 'manifests', 'registry.ollama.ai', 'library', name!, tag ?? 'latest'));
  }

  private installed(id: EngineComponentId): boolean {
    const c = this.catalog;
    switch (id) {
      case 'answer-runtime':
        return this.ollamaExe() !== null;
      case 'speech-runtime': {
        const dir = join(this.whisperDir, c.speechRuntime.dir);
        return !!findFile(dir, (n) => n.toLowerCase() === 'whisper-server.exe') && !!findFile(dir, (n) => n.toLowerCase() === c.speechRuntime.marker.toLowerCase());
      }
      case 'speech-model': {
        const p = join(this.whisperDir, 'models', c.speechModel.file);
        return existsSync(p) && statSync(p).size === c.speechModel.bytes;
      }
      case 'answer-model':
        return this.answerModelOnDisk();
    }
  }

  private componentInfo(id: EngineComponentId): { detail: string; bytes: number } {
    const c = this.catalog;
    switch (id) {
      case 'answer-runtime':
        return { detail: ANSWER_RUNTIME.label, bytes: ANSWER_RUNTIME.bytes };
      case 'speech-runtime':
        return { detail: c.speechRuntime.label, bytes: c.speechRuntime.bytes };
      case 'speech-model':
        return { detail: c.speechModel.label, bytes: c.speechModel.bytes };
      case 'answer-model':
        return { detail: `${c.answerModel.label} (${c.answerModel.tag})`, bytes: c.answerModel.bytes };
    }
  }

  private freeDisk(): number | null {
    try {
      mkdirSync(this.root, { recursive: true });
      const s = statfsSync(this.root);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  status(): EngineStatus {
    const components: EngineComponentStatus[] = ORDER.map((id) => {
      const info = this.componentInfo(id);
      const ok = this.installed(id);
      const l = this.live.get(id);
      return {
        id,
        label: LABELS[id],
        detail: info.detail,
        state: l?.state ?? (ok ? 'ready' : 'missing'),
        bytesTotal: info.bytes,
        bytesDone: l?.bytesDone ?? (ok ? info.bytes : 0),
        error: l?.error ?? null,
      };
    });
    const ready = components.every((c) => c.state === 'ready');
    return {
      tier: this.tier,
      tierSetting: this.deps.settings().engine.tier,
      gpu: this.gpu ?? null,
      ready,
      running: { speech: this.whisper.running, answers: this.ollama.running },
      setup: this.setupState,
      components,
      downloadBytes: components.filter((c) => c.state !== 'ready').reduce((a, c) => a + c.bytesTotal - c.bytesDone, 0),
      freeDiskBytes: this.freeDisk(),
      speechModel: this.catalog.speechModel.label,
      answerModel: this.catalog.answerModel.label,
      error: this.setupError,
    };
  }

  /** Waits for the GPU probe, then reports what is installed. */
  async refresh(): Promise<EngineStatus> {
    await this.gpuProbe;
    const s = this.status();
    this.push(true, s);
    return s;
  }

  private push(force = false, s?: EngineStatus): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.deps.emit(s ?? this.status());
  }

  private set(id: EngineComponentId, patch: Partial<EngineComponentStatus>, force = false): void {
    this.live.set(id, { ...this.live.get(id), ...patch });
    this.push(force);
  }

  get busy(): boolean {
    return this.setupState === 'running';
  }

  /** Installs whatever is missing. Safe to call again after a failure: downloads resume. */
  async setup(): Promise<void> {
    if (this.busy) return;
    await this.refresh();
    this.setupState = 'running';
    this.setupError = null;
    this.live.clear();
    const ctl = new AbortController();
    this.abort = ctl;
    const missing = ORDER.filter((id) => !this.installed(id));
    for (const id of missing) this.live.set(id, { state: 'queued', bytesDone: 0 });
    this.push(true);
    try {
      const need = this.status().downloadBytes;
      const free = this.freeDisk();
      // Archives are unpacked next to themselves before being deleted.
      if (free !== null && free < need * 1.6 + 1e9) {
        throw new Error(`Not enough free disk space: setup needs about ${(need * 1.6 / 1e9 + 1).toFixed(1)} GB on ${this.root.slice(0, 3)} and ${(free / 1e9).toFixed(1)} GB is free.`);
      }
      for (const id of missing) {
        if (ctl.signal.aborted) break;
        await this.install(id, ctl.signal);
        this.live.delete(id);
        this.push(true);
      }
      this.setupState = ctl.signal.aborted ? 'cancelled' : 'done';
    } catch (err) {
      const e = err as Error;
      const cancelled = ctl.signal.aborted || e.name === 'AbortError';
      this.setupState = cancelled ? 'cancelled' : 'error';
      this.setupError = cancelled ? null : e.message;
      for (const [id, l] of this.live) if (l.state !== 'queued') this.live.set(id, { ...l, state: cancelled ? 'missing' : 'error', error: cancelled ? null : e.message });
      this.deps.log.warn('engine setup stopped', { cancelled, error: e.message });
    } finally {
      for (const [id, l] of this.live) if (l.state === 'queued' || l.state === 'missing') this.live.delete(id);
      this.abort = null;
      this.push(true);
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  private async install(id: EngineComponentId, signal: AbortSignal): Promise<void> {
    const downloads = join(this.root, 'downloads');
    const progress = (p: { done: number }) => this.set(id, { state: 'downloading', bytesDone: p.done });
    const verify = () => this.set(id, { state: 'verifying' }, true);
    const c = this.catalog;
    const t0 = Date.now();
    switch (id) {
      case 'answer-runtime': {
        const zip = join(downloads, ANSWER_RUNTIME.file);
        if (!existsSync(zip)) await downloadPinned(ANSWER_RUNTIME, zip, { fetchImpl: this.deps.fetchImpl, signal, onProgress: progress, onVerify: verify });
        this.set(id, { state: 'installing' }, true);
        rmSync(this.runtimeDir, { recursive: true, force: true });
        await extractZip(zip, this.runtimeDir, signal);
        if (!existsSync(join(this.runtimeDir, 'ollama.exe'))) throw new Error('The answer engine archive did not contain ollama.exe.');
        unlinkSync(zip);
        break;
      }
      case 'speech-runtime': {
        const zip = join(downloads, c.speechRuntime.file);
        if (!existsSync(zip)) await downloadPinned(c.speechRuntime, zip, { fetchImpl: this.deps.fetchImpl, signal, onProgress: progress, onVerify: verify });
        this.set(id, { state: 'installing' }, true);
        const dir = join(this.whisperDir, c.speechRuntime.dir);
        rmSync(dir, { recursive: true, force: true });
        await extractZip(zip, dir, signal);
        if (!findFile(dir, (n) => n.toLowerCase() === 'whisper-server.exe')) throw new Error('The speech archive did not contain whisper-server.exe.');
        unlinkSync(zip);
        break;
      }
      case 'speech-model': {
        await downloadPinned(c.speechModel, join(this.whisperDir, 'models', c.speechModel.file), { fetchImpl: this.deps.fetchImpl, signal, onProgress: progress, onVerify: verify });
        break;
      }
      case 'answer-model': {
        this.ollama.exe = this.ollamaExe();
        this.ollama.modelsDir = this.modelsDir();
        this.ollama.contextLength = this.catalog.answerContext;
        const up = await this.ollama.ensure();
        if (!up.ok) throw new Error(up.error ?? 'The answer engine did not start.');
        await this.pull(c.answerModel.tag, c.answerModel.bytes, signal, (done) => this.set(id, { state: 'downloading', bytesDone: done }));
        break;
      }
    }
    this.deps.log.info('engine component installed', { id, tier: this.tier, s: Math.round((Date.now() - t0) / 1000) });
  }

  /** `ollama pull` through the API: Ollama downloads and checks every layer's digest. */
  private async pull(tag: string, expected: number, signal: AbortSignal, onDone: (bytes: number) => void): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.ollamaPort}/api/pull`, { method: 'POST', body: JSON.stringify({ model: tag, stream: true }), signal });
    if (!res.ok || !res.body) throw new Error(`Could not download ${tag} (HTTP ${res.status}).`);
    const layers = new Map<string, number>();
    let buf = '';
    let success = false;
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as { status?: string; digest?: string; completed?: number; total?: number; error?: string };
        if (m.error) throw new Error(`Downloading ${tag} failed: ${m.error}`);
        if (m.digest && typeof m.completed === 'number') layers.set(m.digest, m.completed);
        if (m.status === 'success') success = true;
        onDone(Math.min(expected, [...layers.values()].reduce((a, b) => a + b, 0)));
      }
    }
    if (!success) throw new Error(`Downloading ${tag} did not finish; press Set up again to resume.`);
  }

  /** Starts both servers (no-op when they are already up). Returns the first problem, if any. */
  async start(): Promise<string | null> {
    await this.gpuProbe;
    const files = this.whisperFiles();
    this.whisper.files = files ? { ...files, threads: this.catalog.whisperThreads } : null;
    this.ollama.exe = this.ollamaExe();
    this.ollama.modelsDir = this.modelsDir();
    this.ollama.contextLength = this.catalog.answerContext;
    const [w, o] = await Promise.all([this.whisper.ensure(), this.ollama.ensure()]);
    this.push(true);
    return w.error ?? o.error;
  }

  /** Starts speech recognition only (what listening needs first). Returns the problem, if any. */
  async startSpeech(): Promise<string | null> {
    await this.gpuProbe;
    const files = this.whisperFiles();
    this.whisper.files = files ? { ...files, threads: this.catalog.whisperThreads } : null;
    return (await this.whisper.ensure()).error;
  }

  /**
   * If the user's own Ollama (port 11434) is holding our answer model in GPU memory, ask it to
   * let go: two copies would not fit next to Whisper on a typical 8 GB card.
   */
  async releaseSystemOllamaCopy(): Promise<void> {
    try {
      const ps = (await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(800) })).json()) as { models?: Array<{ name?: string; model?: string }> };
      const tag = this.answerModel;
      if (!ps.models?.some((m) => m.name === tag || m.model === tag)) return;
      await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: tag, keep_alive: 0 }), signal: AbortSignal.timeout(5000) });
      this.deps.log.info('released answer model from the separate Ollama on 11434');
    } catch {
      /* no separate Ollama running */
    }
  }

  stop(): void {
    this.abort?.abort();
    this.whisper.stop();
    this.ollama.stop();
  }
}
