import type {
  AnswerRecord,
  AppSettings,
  AudioSource,
  LiveEvent,
  LiveSnapshot,
  PerfSample,
  SessionState,
  SourceState,
  SourceStatus,
  SttProviderId,
  TranscriptSegment,
} from '@hirora/contracts';
import type { ProviderError, StreamingTranscriptionProvider, SttOptions } from '@hirora/providers';
import { pcmLevelDbfs } from './vad';
import { SttStream } from './sttStream';
import type { SttConnState } from './sttStream';
import { TranscriptAssembler } from './transcript';
import { analyzeQuestion, extractQuestion } from './question';
import type { AnswerEngine } from './answer';

/** Abstraction over the native helper so the controller is testable without hardware. */
export interface AudioInput {
  start(source: AudioSource, opts: { deviceId: string | null; pid: number | null; gain: number }): Promise<void>;
  stop(source: AudioSource): Promise<void>;
  isRunning(): boolean;
}

export interface SessionDeps {
  audio: AudioInput;
  settings(): AppSettings;
  createTranscriber(): StreamingTranscriptionProvider | null;
  answer: AnswerEngine;
  emit(ev: LiveEvent): void;
  history(): {
    start(id: string, mode: string, profileName: string | null): void;
    end(id: string): void;
    segment(id: string, seg: TranscriptSegment): void;
  } | null;
  recordSttSeconds(provider: SttProviderId, seconds: number): void;
  sttBudgetCheck(): { ok: true } | { ok: false; reason: string };
  usageToday(): LiveSnapshot['usageToday'];
  activeProfileName(): string | null;
  perf(sample: PerfSample): void;
  helperInfo(): LiveSnapshot['helper'];
  now?: () => number;
}

interface SourceRuntime {
  status: SourceStatus;
  stt: SttStream;
  assembler: TranscriptAssembler;
  muted: boolean;
  peakSinceEmit: number;
}

const MAX_SEGMENTS = 400;

export class SessionController {
  private state: SessionState = 'idle';
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private consent = false;
  private readonly sources = new Map<AudioSource, SourceRuntime>();
  private readonly segments: TranscriptSegment[] = [];
  private candidate: LiveSnapshot['questionCandidate'] = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private budgetTimer: ReturnType<typeof setInterval> | null = null;
  private recordHistory = false;
  private readonly now: () => number;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? Date.now;
  }

  get sessionState(): SessionState {
    return this.state;
  }

  get transcript(): TranscriptSegment[] {
    return this.segments;
  }

  private enabledSources(s: AppSettings): AudioSource[] {
    const out: AudioSource[] = [];
    if (s.audio.micEnabled) out.push('mic');
    if (s.audio.systemEnabled) out.push(s.audio.appCapturePid ? 'app' : 'system');
    return out;
  }

  snapshot(): LiveSnapshot {
    const s = this.deps.settings();
    return {
      session: this.state,
      sessionId: this.sessionId,
      sessionStartedAt: this.startedAt,
      consentAcknowledged: this.consent,
      sources: [...this.sources.values()].map((r) => ({ ...r.status })),
      sttProvider: s.stt.provider,
      helper: this.deps.helperInfo(),
      mode: s.answer.mode,
      activeProfileName: this.deps.activeProfileName(),
      questionCandidate: this.candidate,
      usageToday: this.deps.usageToday(),
    };
  }

  private pushSnapshot(): void {
    this.deps.emit({ type: 'snapshot', snapshot: this.snapshot() });
  }

  async start(consent: boolean): Promise<LiveSnapshot> {
    if (!consent) throw new Error('Explicit consent is required before audio capture starts');
    if (this.state === 'listening' || this.state === 'starting') return this.snapshot();
    const budget = this.deps.sttBudgetCheck();
    if (!budget.ok) {
      this.deps.emit({ type: 'toast', level: 'error', message: budget.reason });
      return this.snapshot();
    }
    this.consent = true;
    const settings = this.deps.settings();
    if (!this.sessionId) {
      this.sessionId = `ses-${this.now().toString(36)}`;
      this.startedAt = this.now();
      this.recordHistory = settings.privacy.saveHistory;
      if (this.recordHistory) this.deps.history()?.start(this.sessionId, settings.answer.mode, this.deps.activeProfileName());
    }
    this.state = 'starting';
    this.pushSnapshot();
    await this.startSources(settings);
    this.state = 'listening';
    this.levelTimer ??= setInterval(() => this.emitLevels(), 66);
    this.budgetTimer ??= setInterval(() => {
      const b = this.deps.sttBudgetCheck();
      if (!b.ok && this.state === 'listening') {
        this.deps.emit({ type: 'toast', level: 'error', message: b.reason });
        void this.pause();
      }
    }, 60_000);
    this.pushSnapshot();
    return this.snapshot();
  }

  private async startSources(settings: AppSettings): Promise<void> {
    for (const source of this.enabledSources(settings)) {
      const rt = this.ensureSource(source);
      rt.status.state = 'connecting';
      rt.status.message = null;
      rt.stt.start();
      try {
        await this.deps.audio.start(source, {
          deviceId: source === 'mic' ? settings.audio.micDeviceId : source === 'system' ? settings.audio.systemDeviceId : null,
          pid: source === 'app' ? settings.audio.appCapturePid : null,
          gain: source === 'mic' ? settings.audio.micGain : 1,
        });
      } catch (err) {
        rt.status.state = 'failed';
        rt.status.message = (err as Error).message;
        rt.stt.stop();
      }
    }
    this.pushSnapshot();
  }

  private ensureSource(source: AudioSource): SourceRuntime {
    let rt = this.sources.get(source);
    if (rt) return rt;
    const status: SourceStatus = {
      source,
      state: 'off',
      deviceName: null,
      levelDbfs: -100,
      sttState: 'idle',
      sttError: null,
      framesSent: 0,
      framesDropped: 0,
      framesPadded: 0,
      message: null,
    };
    const assembler = new TranscriptAssembler(
      source,
      (seg) => this.onSegmentUpdate(seg),
      (seg) => this.onSegmentFinal(seg),
      this.now,
    );
    const sttOpts = (): SttOptions => {
      const s = this.deps.settings().stt;
      return { language: s.language, vocabulary: s.customVocabulary, geminiMode: s.geminiMode, endpointingMs: s.endpointingMs };
    };
    const stt = new SttStream({
      source,
      createProvider: () => this.deps.createTranscriber(),
      options: sttOpts,
      gateDb: () => this.deps.settings().audio.noiseGateDbfs,
      onInterim: (t) => assembler.interim(t),
      onFinal: (t) => assembler.finalSegment(t),
      onUtteranceEnd: () => assembler.finalize(),
      onState: (st: SttConnState, err: ProviderError | null) => {
        status.sttState = st;
        status.sttError = err ? `${err.message}` : st === 'open' ? null : status.sttError;
        this.pushSnapshot();
      },
      onAudioSent: (secs) => this.deps.recordSttSeconds(this.deps.settings().stt.provider, secs),
      perf: (s) => this.deps.perf(s),
      now: this.now,
    });
    rt = { status, stt, assembler, muted: false, peakSinceEmit: -100 };
    this.sources.set(source, rt);
    return rt;
  }

  /** Called by the audio helper client for every 20 ms frame. */
  onFrame(source: AudioSource, pcm: Buffer): void {
    const rt = this.sources.get(source);
    if (!rt || this.state !== 'listening') return;
    const level = pcmLevelDbfs(pcm);
    rt.peakSinceEmit = Math.max(rt.peakSinceEmit, level);
    rt.status.levelDbfs = level;
    if (rt.muted) return;
    rt.stt.pushFrame(pcm, level);
  }

  onSourceStatus(source: AudioSource, state: string, info: { deviceName?: string | null; message?: string | null }): void {
    const rt = this.sources.get(source);
    if (!rt) return;
    const map: Record<string, SourceState> = {
      starting: 'connecting',
      streaming: rt.muted ? 'muted' : 'streaming',
      reconnecting: 'reconnecting',
      stopped: 'off',
      failed: 'failed',
    };
    rt.status.state = map[state] ?? rt.status.state;
    if (info.deviceName !== undefined) rt.status.deviceName = info.deviceName ?? rt.status.deviceName;
    rt.status.message = info.message ?? (state === 'streaming' ? null : rt.status.message);
    this.pushSnapshot();
  }

  onHelperStats(stats: Partial<Record<AudioSource, { framesSent: number; framesDropped: number; framesPadded: number }>>): void {
    for (const [src, rt] of this.sources) {
      const s = stats[src];
      if (s) {
        rt.status.framesSent = s.framesSent;
        rt.status.framesDropped = s.framesDropped;
        rt.status.framesPadded = s.framesPadded;
      }
    }
  }

  private emitLevels(): void {
    if (this.sources.size === 0) return;
    const levels: Partial<Record<AudioSource, number>> = {};
    for (const [src, rt] of this.sources) {
      levels[src] = rt.status.state === 'off' ? -100 : rt.peakSinceEmit;
      rt.peakSinceEmit = -100;
    }
    this.deps.emit({ type: 'levels', levels: levels as Record<AudioSource, number> });
  }

  private onSegmentUpdate(seg: TranscriptSegment): void {
    this.deps.emit({ type: 'transcript', segment: seg });
  }

  private onSegmentFinal(seg: TranscriptSegment): void {
    this.segments.push(seg);
    if (this.segments.length > MAX_SEGMENTS) this.segments.splice(0, this.segments.length - MAX_SEGMENTS);
    if (this.recordHistory && this.sessionId) this.deps.history()?.segment(this.sessionId, seg);
    if (!seg.isQuestion) return;
    const text = extractQuestion(this.withLeadIn(seg));
    this.candidate = { text, source: seg.source as AudioSource, score: seg.questionScore };
    this.pushSnapshot();
    const s = this.deps.settings();
    if (!s.answer.autoAnswer || s.answer.mode === 'meeting_notes') return;
    if (!s.answer.autoAnswerSources.includes(seg.source as AudioSource)) return;
    // Short debounce: a follow-up fragment arriving immediately is merged.
    if (this.autoTimer) clearTimeout(this.autoTimer);
    const finalAt = seg.endedAt ?? this.now();
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      const c = this.candidate;
      if (!c) return;
      this.deps.perf({ stage: 'final_to_question', ms: this.now() - finalAt, at: this.now(), provider: null, model: null, label: seg.source });
      this.deps.answer.ask({ question: c.text, origin: c.source, questionEndedAt: finalAt });
    }, 250);
  }

  /** Prepend a short preceding statement from the same source ("I see you used Kafka. Why?"). */
  private withLeadIn(seg: TranscriptSegment): string {
    const idx = this.segments.lastIndexOf(seg);
    const prev = idx > 0 ? this.segments[idx - 1] : undefined;
    if (
      prev &&
      prev.source === seg.source &&
      !prev.isQuestion &&
      prev.endedAt !== null &&
      seg.startedAt - prev.endedAt < 6000 &&
      prev.text.length < 280
    ) {
      return `${prev.text} ${seg.text}`;
    }
    return seg.text;
  }

  /** Manual "Ask": answer the current candidate or, failing that, the most recent speech. */
  askLatest(): { requestId: string | null; error: string | null } {
    const s = this.deps.settings();
    // Finalize any utterance in progress so its words are included.
    for (const [src, rt] of this.sources) {
      if (s.answer.autoAnswerSources.includes(src) || src === 'mic') {
        rt.stt.endOfSpeech();
        rt.assembler.finalize();
      }
    }
    let text = this.candidate?.text ?? null;
    let origin: AnswerRecord['questionSource'] = this.candidate?.source ?? 'system';
    if (!text) {
      const recent = [...this.segments].reverse().find((x) => x.final && x.text.trim().length > 0);
      if (recent) {
        text = this.withLeadIn(recent);
        origin = recent.source === 'typed' ? 'typed' : recent.source;
      }
    }
    if (!text) return { requestId: null, error: 'Nothing heard yet. Type a question or start listening first.' };
    const id = this.deps.answer.ask({ question: text, origin, questionEndedAt: this.now() });
    this.candidate = null;
    this.pushSnapshot();
    return { requestId: id, error: null };
  }

  askSegment(segmentId: string): { requestId: string | null; error: string | null } {
    const seg = this.segments.find((x) => x.id === segmentId);
    if (!seg) return { requestId: null, error: 'Transcript segment not found' };
    const id = this.deps.answer.ask({ question: seg.text, origin: seg.source === 'typed' ? 'typed' : seg.source, questionEndedAt: this.now() });
    return { requestId: id, error: null };
  }

  /** Record a typed question in the transcript so follow-ups have context. */
  noteTyped(text: string): void {
    const q = analyzeQuestion(text);
    const seg: TranscriptSegment = {
      id: `typed-${this.now().toString(36)}`,
      source: 'typed',
      text,
      final: true,
      startedAt: this.now(),
      endedAt: this.now(),
      isQuestion: q.isQuestion,
      questionScore: q.score,
    };
    this.segments.push(seg);
    this.deps.emit({ type: 'transcript', segment: seg });
    if (this.recordHistory && this.sessionId) this.deps.history()?.segment(this.sessionId, seg);
  }

  async setMuted(source: AudioSource, muted: boolean): Promise<LiveSnapshot> {
    const rt = this.sources.get(source);
    if (rt) {
      rt.muted = muted;
      rt.status.state = muted ? 'muted' : rt.status.state === 'muted' ? 'streaming' : rt.status.state;
      if (muted) rt.assembler.finalize();
    }
    this.pushSnapshot();
    return this.snapshot();
  }

  /** Pause stops capture entirely (no audio leaves the device) but keeps the session. */
  async pause(): Promise<LiveSnapshot> {
    if (this.state !== 'listening') return this.snapshot();
    this.state = 'paused';
    await this.stopSources();
    this.pushSnapshot();
    return this.snapshot();
  }

  async resume(): Promise<LiveSnapshot> {
    if (this.state !== 'paused') return this.snapshot();
    const b = this.deps.sttBudgetCheck();
    if (!b.ok) {
      this.deps.emit({ type: 'toast', level: 'error', message: b.reason });
      return this.snapshot();
    }
    this.state = 'starting';
    this.pushSnapshot();
    await this.startSources(this.deps.settings());
    this.state = 'listening';
    this.pushSnapshot();
    return this.snapshot();
  }

  private async stopSources(): Promise<void> {
    for (const [src, rt] of this.sources) {
      rt.assembler.finalize();
      rt.stt.stop();
      try {
        await this.deps.audio.stop(src);
      } catch {
        /* helper may already be gone */
      }
      rt.status.state = 'off';
      rt.status.levelDbfs = -100;
    }
  }

  async stop(): Promise<LiveSnapshot> {
    if (this.state === 'idle') return this.snapshot();
    this.state = 'stopping';
    this.pushSnapshot();
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    await this.stopSources();
    for (const rt of this.sources.values()) rt.assembler.dispose();
    this.sources.clear();
    if (this.levelTimer) clearInterval(this.levelTimer);
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    this.levelTimer = this.budgetTimer = null;
    if (this.recordHistory && this.sessionId) this.deps.history()?.end(this.sessionId);
    this.sessionId = null;
    this.startedAt = null;
    this.candidate = null;
    this.state = 'idle';
    this.consent = false;
    this.pushSnapshot();
    return this.snapshot();
  }

  clearTranscript(): void {
    this.segments.length = 0;
    this.candidate = null;
    this.deps.answer.clearMemory();
    this.pushSnapshot();
  }

  /** Re-read device/source settings while listening (device switch mid-session). */
  async applyAudioSettings(): Promise<void> {
    if (this.state !== 'listening') return;
    await this.stopSources();
    this.sources.clear();
    await this.startSources(this.deps.settings());
  }
}
