import { app, net } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AnswerRecord,
  AppSettings,
  AudioSource,
  LiveEvent,
  PerfSample,
  ProviderId,
  RetrievedChunk,
} from '@hirora/contracts';
import { LIVE_EVENT_CHANNEL, LOCAL_ENGINE } from '@hirora/contracts';
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
import { AnswerEngine, SessionController, refersToScreen, runGate } from '@hirora/orchestration';
import type { AudioInput } from '@hirora/orchestration';
import { createAnswerProvider, createTranscriber, runWhisperInference, toProviderError } from '@hirora/providers';
import type { FetchLike, TextModelProvider } from '@hirora/providers';
import { SettingsStore } from '@hirora/settings';
import { AudioHelper } from './audioHelper';
import type { Logger } from './logger';
import type { WindowManager } from './windows';
import { EngineManager } from './engine';
import { captureScreen } from './screenCapture';
import { SavaOnnxEngine } from './stt/savaOnnx';

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
  readonly engine: EngineManager;
  readonly sava: SavaOnnxEngine;
  private answerProvider: TextModelProvider | null = null;
  windows: WindowManager | null = null;
  private keepWarmTimer: ReturnType<typeof setInterval> | null = null;
  private warming: Promise<void> | null = null;

  constructor(readonly log: Logger) {
    const userData = app.getPath('userData');
    this.settings = new SettingsStore(join(userData, 'settings.json'));
    this.db = new DatabaseSync(join(userData, 'hirora.db')) as unknown as SqlDatabase;
    migrate(this.db);
    this.knowledge = new KnowledgeStore(this.db);
    this.retriever = new HybridRetriever(this.knowledge);
    this.history = new HistoryStore(this.db);
    this.perf = new PerfStore(this.db);
    this.usage = new UsageStore(this.db);
    this.captureResults = new CaptureResultStore(this.db);
    this.helper = new AudioHelper(resolveHelperPath(), log);
    this.sava = new SavaOnnxEngine(log);
    void this.sava.start();
    this.engine = new EngineManager({
      log,
      settings: () => this.settings.get(),
      emit: (status) => this.emit({ type: 'engine', status }),
      fetchImpl: netFetch,
    });

    this.answer = new AnswerEngine({
      settings: () => this.settings.get(),
      resolveProvider: (id) => this.resolveProvider(id),
      retrieve: (q, signal, opts) => this.retrieve(q, signal, opts),
      stableResume: () => this.stableResume(),
      lean: () => this.engine.tier === 'cpu',
      ready: () => this.ensureEngine(),
      screen: (question) => this.screenFor(question),
      context: () => ({
        personal: this.knowledge.getProfile(),
        session: this.knowledge.getSessionProfile(this.settings.get().activeProfileId),
        transcript: this.session.transcript,
      }),
      recordUsage: (provider, model, usage) => {
        this.usage.recordAnswer(provider, model, usage?.inputTokens ?? null, usage?.outputTokens ?? null, null);
      },
      perf: (s) => this.recordPerf(s),
      emit: (rec) => this.onAnswer(rec),
      emitDelta: (requestId, delta, seq) => this.emit({ type: 'answer_delta', requestId, delta, seq }),
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
      createTranscriber: () => createTranscriber({ url: this.engine.whisperUrl, interimEveryMs: this.engine.interimEveryMs, fetchImpl: netFetch }),
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
      usageToday: () => this.usage.today(),
      activeProfileName: () => this.knowledge.getSessionProfile(this.settings.get().activeProfileId)?.name ?? null,
      perf: (s) => this.recordPerf(s),
      helperInfo: () => ({ running: this.helper.running, version: this.helper.version, error: this.helper.lastError }),
      earlyAnswers: () => this.engine.tier === 'gpu',
      whisperClient: {
        decode: async (req) => {
          try {
            const parsed = await runWhisperInference(`${this.engine.whisperUrl}/inference`, netFetch, req.pcm, {
              language: this.settings.get().stt.language,
              prompt: req.prompt,
              beamSize: req.beamSize,
              wordTimestamps: true,
            });
            return { text: parsed.text, words: parsed.words, wordTimestamps: parsed.wordTimestamps };
          } catch (err) {
            this.log.warn('whisper window decode failed', { error: (err as Error).message, source: req.source });
            return null;
          }
        },
      },
      savaScores: (source, pcm, _energy) => (this.sava.ready ? this.sava.scores(source, pcm) : null),
      profileVocabulary: () => {
        const p = this.knowledge.getProfile();
        const sp = this.knowledge.getSessionProfile(this.settings.get().activeProfileId);
        return [...p.skills, sp?.company ?? '', sp?.role ?? ''].map((x) => x.trim()).filter(Boolean);
      },
      // Same local model as answers: one fast one-word call for lines that might be questions.
      // Hirora's Ollama serves two requests at once, so the check never waits behind an answer.
      gate: async (utterance, recent, signal) => {
        const r = this.resolveProvider(LOCAL_ENGINE);
        if (!r) return null;
        return runGate(r.provider, r.model, { utterance, recent, candidateName: this.candidateName() }, signal);
      },
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
      if (next.engine.tier !== prev.engine.tier) {
        // Different models: stop the old servers; the next Start (or warm-up) runs the new ones.
        this.engine.stop();
        void this.engine.refresh();
      }
    });

    const retention = this.settings.get().privacy;
    if (retention.saveHistory) this.history.applyRetention(retention.historyRetentionDays);
  }

  /** The user's name for the question check: profile first, else the newest résumé's title ("Jane_Doe_Resume"). */
  candidateName(): string | null {
    const fromProfile = this.knowledge.getProfile().fullName?.trim();
    if (fromProfile) return fromProfile;
    const resume = this.knowledge.listDocuments().find((d) => d.kind === 'resume');
    const guess = resume?.title.replace(/[_\-.]+/g, ' ').replace(/\b(resume|résumé|cv|final|updated|new|\d{4})\b/gi, '').replace(/\s+/g, ' ').trim();
    return guess && guess.split(' ').length <= 5 ? guess : null;
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

  /** The answer engine, once it is installed. */
  resolveProvider(id: ProviderId): { provider: TextModelProvider; model: string; deepModel: string } | null {
    if (id !== LOCAL_ENGINE || !this.engine.ollamaExe()) return null;
    this.answerProvider ??= createAnswerProvider({ baseUrl: this.engine.ollamaUrl, fetchImpl: netFetch });
    const model = this.engine.answerModel;
    return { provider: this.answerProvider, model, deepModel: model };
  }

  /**
   * While listening, keep the answer model loaded: Ollama unloads idle models after a few
   * minutes, and reloading costs seconds, which would make the next answer slow.
   */
  private keepWarm(): void {
    if (this.keepWarmTimer) return;
    this.keepWarmTimer = setInterval(() => {
      if (this.session.sessionState !== 'listening') {
        if (this.keepWarmTimer) clearInterval(this.keepWarmTimer);
        this.keepWarmTimer = null;
        return;
      }
      const r = this.resolveProvider(LOCAL_ENGINE);
      void r?.provider.preconnect(AbortSignal.timeout(60_000), r.model).catch(() => undefined);
    }, 4 * 60_000);
  }

  /** The newest résumé in reading order, capped so prompt + answer fit a 4K local context. */
  stableResume(): RetrievedChunk[] {
    const doc = this.knowledge.listDocuments().find((d) => d.kind === 'resume');
    if (!doc) return [];
    const out: RetrievedChunk[] = [];
    let chars = 0;
    for (const c of this.knowledge.getChunks(doc.id)) {
      if (chars + c.text.length > 8000) break;
      chars += c.text.length;
      out.push({ chunkId: c.id, documentId: doc.id, documentTitle: doc.title, fileName: doc.fileName, kind: 'resume', evidence: 'my_facts', page: c.page, section: c.section, ordinal: c.ordinal, text: c.text, score: 1, matchedBy: ['profile'] });
    }
    return out;
  }

  /**
   * Gets the engine ready for questions: starts speech recognition and the answer engine,
   * loads the answer model into memory and has it pre-read the résumé. Measured.
   */
  warmUp(): Promise<void> {
    this.warming ??= this.doWarmUp().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  private async doWarmUp(): Promise<void> {
    const st = await this.engine.refresh();
    if (!st.ready) return;
    const problem = await this.engine.start();
    if (problem) {
      this.log.warn('engine start problem', { error: problem });
      this.emit({ type: 'toast', level: 'error', message: `${problem} Restart Hirora; if it keeps happening, Settings → Engine shows what is missing.` });
    }
    const r = this.resolveProvider(LOCAL_ENGINE);
    if (!r) return;
    await this.engine.releaseSystemOllamaCopy();
    const t0 = performance.now();
    try {
      await r.provider.preconnect(AbortSignal.timeout(180_000), r.model);
      this.recordPerf({ stage: 'provider_preconnect', ms: performance.now() - t0, at: Date.now(), provider: LOCAL_ENGINE, model: r.model, label: 'model-load' });
      const p0 = performance.now();
      if (await this.answer.prime(AbortSignal.timeout(90_000))) this.recordPerf({ stage: 'provider_preconnect', ms: performance.now() - p0, at: Date.now(), provider: LOCAL_ENGINE, model: r.model, label: 'prompt-preread' });
    } catch (err) {
      this.log.warn('answer model warm-up failed', { error: toProviderError(LOCAL_ENGINE, err).message });
    }
  }

  /**
   * The screen for a question that points at something shown ("add RBAC to this code"), or
   * every question with the `always` setting. Only for an answer model that reads images.
   * Held in memory for this one request; never written to disk.
   */
  async screenFor(question: string): Promise<Array<{ type: 'image'; mimeType: 'image/jpeg'; base64: string }> | null> {
    const mode = this.settings.get().answer.screen;
    if (mode === 'off' || !this.engine.answerModelReadsImages) return null;
    if (mode === 'auto' && !refersToScreen(question)) return null;
    const t0 = performance.now();
    const shot = await captureScreen(this.windows);
    this.recordPerf({ stage: 'screen_capture', ms: performance.now() - t0, at: Date.now(), provider: null, model: null, label: shot ? `${shot.width}x${shot.height}` : 'failed' });
    return shot ? [{ type: 'image', mimeType: 'image/jpeg', base64: shot.base64 }] : null;
  }

  /** For an answer about to be sent: waits for a warm-up in progress, or starts the engine if it is down. */
  async ensureEngine(): Promise<void> {
    if (this.warming) return this.warming;
    if (!(await this.engine.ollama.isUp())) await this.warmUp();
  }

  /** Called when listening starts: same as warmUp, and keeps the model loaded while listening. */
  async preconnect(): Promise<void> {
    this.keepWarm();
    await this.warmUp();
  }

  async retrieve(question: string, _signal: AbortSignal, opts?: { compact?: boolean }): Promise<{ chunks: RetrievedChunk[]; ms: number; usedVectors: boolean }> {
    const t0 = performance.now();
    const s = this.settings.get();
    const chunks = this.retriever.retrieve(question, { topK: s.knowledge.topK, queryVector: null, embeddingModel: null, maxResumeChunks: opts?.compact ? 6 : undefined });
    return { chunks, ms: performance.now() - t0, usedVectors: false };
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
    if (this.keepWarmTimer) clearInterval(this.keepWarmTimer);
    this.engine.stop();
    await this.helper.shutdown();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
