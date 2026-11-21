import { app, net, safeStorage } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AnswerRecord,
  AppSettings,
  AudioSource,
  LiveEvent,
  ModelInfo,
  PerfSample,
  ProviderHealth,
  ProviderId,
  RetrievedChunk,
} from '@hirora/contracts';
import { LIVE_EVENT_CHANNEL, PROVIDER_IDS, isKeyless } from '@hirora/contracts';
import {
  CaptureResultStore,
  HistoryStore,
  HybridRetriever,
  KnowledgeStore,
  PerfStore,
  UsageStore,
  migrate,
} from '@hirora/knowledge';
import type { SqlDatabase } from '@hirora/knowledge';
import {
  AnswerEngine,
  SessionController,
  answerBudgetCheck,
  estimateCostUsd,
  sttBudgetCheck,
} from '@hirora/orchestration';
import type { AudioInput } from '@hirora/orchestration';
import {
  ProviderError,
  STT_KEY_PROVIDER,
  createEmbeddingProvider,
  createTextProvider,
  createTranscriber,
  toProviderError,
} from '@hirora/providers';
import type { FetchLike, TextModelProvider } from '@hirora/providers';
import { SecretVault, SettingsStore } from '@hirora/settings';
import type { SecretCipher } from '@hirora/settings';
import { AudioHelper } from './audioHelper';
import type { Logger } from './logger';
import type { WindowManager } from './windows';

class SafeStorageCipher implements SecretCipher {
  readonly backend = process.platform === 'win32' ? 'Electron safeStorage (Windows DPAPI, current user)' : 'Electron safeStorage';
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }
  encrypt(plain: string): Buffer {
    return safeStorage.encryptString(plain);
  }
  decrypt(cipher: Buffer): string {
    return safeStorage.decryptString(cipher);
  }
}

export function resolveHelperPath(): string | null {
  const exe = 'hirora-audio.exe';
  if (app.isPackaged) return join(process.resourcesPath, 'bin', exe);
  const repo = join(app.getAppPath(), '..', '..');
  const candidates = [
    join(repo, 'native', 'windows-audio', 'target', 'release', exe),
    join(repo, 'native', 'windows-audio', 'target', 'debug', exe),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

const netFetch: FetchLike = (input, init) => net.fetch(input, init as RequestInit);

export class AppServices {
  readonly settings: SettingsStore;
  readonly vault: SecretVault;
  readonly db: SqlDatabase;
  readonly knowledge: KnowledgeStore;
  readonly retriever: HybridRetriever;
  readonly history: HistoryStore;
  readonly perf: PerfStore;
  readonly usage: UsageStore;
  readonly captureResults: CaptureResultStore;
  readonly helper: AudioHelper;
  readonly answer: AnswerEngine;
  readonly session: SessionController;
  readonly health = new Map<ProviderId, ProviderHealth>();
  private readonly providerCache = new Map<string, TextModelProvider>();
  private readonly modelsCache = new Map<ProviderId, { models: ModelInfo[]; at: number }>();
  windows: WindowManager | null = null;

  constructor(readonly log: Logger) {
    const userData = app.getPath('userData');
    this.settings = new SettingsStore(join(userData, 'settings.json'));
    this.vault = new SecretVault(join(userData, 'secrets.json'), new SafeStorageCipher());
    this.db = new DatabaseSync(join(userData, 'hirora.db')) as unknown as SqlDatabase;
    migrate(this.db);
    this.knowledge = new KnowledgeStore(this.db);
    this.retriever = new HybridRetriever(this.knowledge);
    this.history = new HistoryStore(this.db);
    this.perf = new PerfStore(this.db);
    this.usage = new UsageStore(this.db);
    this.captureResults = new CaptureResultStore(this.db);
    this.helper = new AudioHelper(resolveHelperPath(), log);
    for (const p of PROVIDER_IDS) {
      this.health.set(p, { provider: p, hasKey: this.isReady(p), status: 'unknown', lastError: null, lastErrorCode: null, lastCheckedAt: null, backoffUntil: null });
    }

    this.answer = new AnswerEngine({
      settings: () => this.settings.get(),
      resolveProvider: (id) => this.resolveProvider(id),
      retrieve: (q, signal) => this.retrieve(q, signal),
      context: () => ({
        personal: this.knowledge.getProfile(),
        session: this.knowledge.getSessionProfile(this.settings.get().activeProfileId),
        transcript: this.session.transcript,
      }),
      budgetCheck: () => answerBudgetCheck(this.settings.get(), this.usage.today(), this.usage.monthCostUsd()),
      recordUsage: (provider, model, usage) => {
        const cost = estimateCostUsd(this.settings.get(), provider, model, usage);
        this.usage.recordAnswer(provider, model, usage?.inputTokens ?? null, usage?.outputTokens ?? null, cost);
        return { costUsd: cost };
      },
      perf: (s) => this.recordPerf(s),
      emit: (rec) => this.onAnswer(rec),
      emitDelta: (requestId, delta, seq) => this.emit({ type: 'answer_delta', requestId, delta, seq }),
      onProviderResult: (id, err) => this.noteProviderResult(id, err),
    });

    const audio: AudioInput = {
      start: async (source, opts) => {
        await this.helper.request('start', { source, deviceId: opts.deviceId, pid: opts.pid, gain: opts.gain });
      },
      stop: async (source) => {
        await this.helper.request('stop', { source });
      },
      isRunning: () => this.helper.running,
    };

    this.session = new SessionController({
      audio,
      settings: () => this.settings.get(),
      createTranscriber: () => {
        const s = this.settings.get().stt.provider;
        const key = this.vault.get(STT_KEY_PROVIDER[s]);
        if (!key) return null;
        try {
          return createTranscriber(s, key, { cloudBaseUrl: this.settings.get().providers.cloud.baseUrl, fetchImpl: netFetch });
        } catch {
          return null;
        }
      },
      answer: this.answer,
      emit: (ev) => this.emit(ev),
      history: () =>
        this.settings.get().privacy.saveHistory
          ? {
              start: (id, mode, name) => this.history.startSession(id, mode, name),
              end: (id) => this.history.endSession(id),
              segment: (id, seg) => this.history.saveSegment(id, seg),
            }
          : null,
      recordSttSeconds: (provider, secs) => this.usage.recordStt(provider, secs),
      sttBudgetCheck: () => sttBudgetCheck(this.settings.get(), this.usage.today()),
      usageToday: () => this.usage.today(),
      activeProfileName: () => this.knowledge.getSessionProfile(this.settings.get().activeProfileId)?.name ?? null,
      perf: (s) => this.recordPerf(s),
      helperInfo: () => ({ running: this.helper.running, version: this.helper.version, error: this.helper.lastError }),
    });

    this.helper.on('frame', (source: AudioSource, pcm: Buffer) => this.session.onFrame(source, pcm));
    this.helper.on('event', (ev: { type: string; source?: AudioSource; state?: string; deviceName?: string; message?: string; reason?: string; [k: string]: unknown }) => {
      if (ev.type === 'status' && ev.source) {
        this.session.onSourceStatus(ev.source, ev.state ?? '', { deviceName: ev.deviceName ?? undefined, message: ev.message ?? ev.reason ?? null });
        if (ev.state === 'failed') this.emit({ type: 'toast', level: 'error', message: `${ev.source === 'mic' ? 'Microphone' : 'System audio'} capture failed: ${ev.message ?? 'unknown error'}` });
      } else if (ev.type === 'stats') {
        this.session.onHelperStats(ev as never);
      } else if (ev.type === 'devices_changed') {
        this.emit({ type: 'command', command: 'devicesChanged', arg: ev });
      } else if (ev.type === 'error') {
        this.log.warn('helper error event', { code: ev.code as string });
      }
    });
    this.helper.on('restarted', () => {
      this.emit({ type: 'toast', level: 'warn', message: 'Audio helper restarted after an unexpected exit.' });
      void this.session.applyAudioSettings();
    });

    this.settings.onChange((next, prev) => {
      // Every window keeps its own store: tell them all to refresh (theme, mode, overlay options…).
      this.emit({ type: 'command', command: 'settingsChanged' });
      if (JSON.stringify(next.audio) !== JSON.stringify(prev.audio)) void this.session.applyAudioSettings();
      for (const p of PROVIDER_IDS) {
        const h = this.health.get(p)!;
        h.hasKey = this.isReady(p);
      }
    });

    const retention = this.settings.get().privacy;
    if (retention.saveHistory) this.history.applyRetention(retention.historyRetentionDays);
  }

  emit(ev: LiveEvent): void {
    for (const w of this.windows?.all() ?? []) {
      if (!w.webContents.isDestroyed()) w.webContents.send(LIVE_EVENT_CHANNEL, ev);
    }
  }

  private onAnswer(rec: AnswerRecord): void {
    this.emit({ type: 'answer', answer: rec });
    if ((rec.status === 'done' || rec.status === 'error') && this.settings.get().privacy.saveHistory) {
      const sid = this.session.snapshot().sessionId;
      if (sid) {
        this.history.startSession(sid, rec.mode, null);
        this.history.saveAnswer(sid, rec);
      }
    }
  }

  recordPerf(s: PerfSample): void {
    try {
      this.perf.record(s);
    } catch (err) {
      this.log.warn('perf record failed', { error: (err as Error).message });
    }
  }

  private noteProviderResult(id: ProviderId, err: ProviderError | null): void {
    const h = this.health.get(id)!;
    h.lastCheckedAt = Date.now();
    if (!err) {
      h.status = 'ok';
      h.lastError = null;
      h.lastErrorCode = null;
      h.backoffUntil = null;
    } else if (err.code !== 'aborted') {
      h.status = err.code === 'rate_limited' ? 'backoff' : 'error';
      h.lastError = err.message;
      h.lastErrorCode = err.code;
      h.backoffUntil = err.code === 'rate_limited' ? Date.now() + 15_000 : null;
    }
  }

  /** A provider can be used once it has a key, or always for local runtimes that need none. */
  isReady(id: ProviderId): boolean {
    return isKeyless(id) || this.vault.has(id);
  }

  getProvider(id: ProviderId): TextModelProvider | null {
    const key = isKeyless(id) ? 'local' : this.vault.get(id);
    if (!key) return null;
    const s = this.settings.get();
    const endpoint = id === 'custom' ? s.providers.custom.baseUrl : id === 'ollama' ? s.providers.ollama.baseUrl : id === 'cloud' ? s.providers.cloud.baseUrl : '';
    const cacheKey = `${id}|${createHash('sha256').update(key).digest('hex').slice(0, 12)}|${endpoint}`;
    let p = this.providerCache.get(cacheKey);
    if (!p) {
      try {
        p = createTextProvider(id, key, { fetchImpl: netFetch, customBaseUrl: s.providers.custom.baseUrl, customLabel: s.providers.custom.label, ollamaBaseUrl: s.providers.ollama.baseUrl, cloudBaseUrl: s.providers.cloud.baseUrl });
      } catch {
        return null;
      }
      this.providerCache.set(cacheKey, p);
    }
    return p;
  }

  resolveProvider(id: ProviderId): { provider: TextModelProvider; model: string; deepModel: string } | null {
    const s = this.settings.get();
    const ps = s.providers[id];
    if (!ps.enabled || !ps.model) return null;
    const h = this.health.get(id);
    if (h?.backoffUntil && h.backoffUntil > Date.now()) return null;
    const provider = this.getProvider(id);
    if (!provider) return null;
    return { provider, model: ps.model, deepModel: ps.deepModel || ps.model };
  }

  async listModels(id: ProviderId, refresh = false): Promise<ModelInfo[]> {
    const cached = this.modelsCache.get(id);
    if (cached && !refresh && Date.now() - cached.at < 10 * 60_000) return cached.models;
    const p = this.getProvider(id);
    if (!p) throw new ProviderError(id, 'not_configured', isKeyless(id) ? 'The local endpoint must be http://127.0.0.1 or http://localhost' : 'No API key saved for this provider');
    const models = (await p.listModels()).filter((m) => m.supportsText).sort((a, b) => a.id.localeCompare(b.id));
    this.modelsCache.set(id, { models, at: Date.now() });
    return models;
  }

  async testProvider(id: ProviderId): Promise<{ ok: boolean; latencyMs: number; models: ModelInfo[]; error: string | null; errorCode: string | null }> {
    const t0 = performance.now();
    const h = this.health.get(id)!;
    h.status = 'checking';
    try {
      const models = await this.listModels(id, true);
      const ms = performance.now() - t0;
      this.noteProviderResult(id, null);
      return { ok: true, latencyMs: Math.round(ms), models, error: null, errorCode: null };
    } catch (err) {
      const pe = toProviderError(id, err);
      this.noteProviderResult(id, pe);
      return { ok: false, latencyMs: Math.round(performance.now() - t0), models: [], error: pe.message, errorCode: pe.code };
    }
  }

  /** Warm connections for the configured answer providers (best-effort, measured). */
  async preconnect(): Promise<void> {
    const s = this.settings.get();
    const ids = [s.answer.primaryProvider, s.answer.fallbackProvider].filter((x): x is ProviderId => !!x);
    await Promise.all(
      ids.map(async (id) => {
        const p = this.getProvider(id);
        if (!p) return;
        const t0 = performance.now();
        try {
          // Local runtimes load the model into memory here, which can take a while on first use.
          const local = isKeyless(id);
          await p.preconnect(AbortSignal.timeout(local ? 120_000 : 8000), local ? s.providers[id].model || undefined : undefined);
          this.recordPerf({ stage: 'provider_preconnect', ms: performance.now() - t0, at: Date.now(), provider: id, model: local ? s.providers[id].model : null, label: local ? 'model-load' : 'text' });
        } catch (err) {
          this.noteProviderResult(id, toProviderError(id, err));
        }
      }),
    );
  }

  async retrieve(question: string, signal: AbortSignal): Promise<{ chunks: RetrievedChunk[]; ms: number; usedVectors: boolean }> {
    const t0 = performance.now();
    const s = this.settings.get();
    let queryVector: Float32Array | null = null;
    const model = s.knowledge.embeddingModel;
    if (s.knowledge.useEmbeddings && this.retriever.hasVectors(model)) {
      const key = this.vault.get('gemini');
      if (key) {
        try {
          const emb = createEmbeddingProvider(key, model, netFetch);
          // Retrieval must stay fast: give the embedding call a short budget, fall back to FTS-only.
          const [v] = await emb.embed([question], 'query', AbortSignal.any([signal, AbortSignal.timeout(900)]));
          queryVector = v ?? null;
        } catch {
          queryVector = null;
        }
      }
    }
    const chunks = this.retriever.retrieve(question, { topK: s.knowledge.topK, queryVector, embeddingModel: queryVector ? model : null });
    return { chunks, ms: performance.now() - t0, usedVectors: !!queryVector };
  }

  async embedMissing(): Promise<{ embedded: number; error: string | null }> {
    const s = this.settings.get();
    const key = this.vault.get('gemini');
    if (!key) return { embedded: 0, error: 'Embeddings use the Gemini API: save a Gemini key first.' };
    const model = s.knowledge.embeddingModel;
    const emb = createEmbeddingProvider(key, model, netFetch);
    let total = 0;
    try {
      for (;;) {
        const rows = this.knowledge.chunksMissingEmbeddings(model, 256);
        if (rows.length === 0) break;
        const vecs = await emb.embed(rows.map((r) => r.text), 'document');
        this.knowledge.saveEmbeddings(model, rows.map((r, i) => ({ chunkId: r.id, vector: vecs[i]! })));
        total += rows.length;
      }
      return { embedded: total, error: null };
    } catch (err) {
      return { embedded: total, error: toProviderError('gemini', err).message };
    }
  }

  healthList(): ProviderHealth[] {
    return PROVIDER_IDS.map((p) => ({ ...this.health.get(p)!, hasKey: this.isReady(p) }));
  }

  settingsValue(): AppSettings {
    return this.settings.get();
  }

  async shutdown(): Promise<void> {
    try {
      await this.session.stop();
    } catch {
      /* ignore */
    }
    await this.helper.shutdown();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
