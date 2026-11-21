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
import { analyzeQuestion, extractQuestion, isFragment, sameQuestion, triageUtterance } from './question';
import type { GateDecision } from './gate';
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
  /**
   * Quick model check for lines that might be questions (see triageUtterance).
   * null = unavailable/failed/timed out: the controller falls back to the score.
   */
  gate?(utterance: string, recent: TranscriptSegment[], signal: AbortSignal): Promise<GateDecision | null>;
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
/** A slow check must not hold a real question back for long. */
const GATE_TIMEOUT_MS = 2500;

export class SessionController {
  private state: SessionState = 'idle';
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private consent = false;
  private readonly sources = new Map<AudioSource, SourceRuntime>();
  private readonly segments: TranscriptSegment[] = [];
  private candidate: LiveSnapshot['questionCandidate'] = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every auto-answer candidate, so a slow check for an older line can't fire. */
  private candidateGen = 0;
  private gateCtl: AbortController | null = null;
  /**
   * An answer started from live text while the other side is still talking. It is
   * revealed when they pause (instant), confirmed by the final transcript, or dropped.
   */
  /** Sources whose speaker is currently in a pause (since when they stopped). */
  private readonly pausedAt = new Map<AudioSource, number>();
  private spec: {
    id: string;
    text: string;
    source: AudioSource;
    decision: 'answer' | 'pending';
    committed: boolean;
    /** Set when they paused while the check was still running: reveal once it says ANSWER. */
    pausedAt: number | null;
  } | null = null;
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
      onPause: (lastSpeechAt) => this.onPause(source, lastSpeechAt),
      onResume: () => this.pausedAt.delete(source),
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
    if (!seg.final && this.state === 'listening' && this.isAutoSource(seg.source)) this.speculate(seg);
  }

  private isAutoSource(source: TranscriptSegment['source']): boolean {
    const s = this.deps.settings();
    return s.answer.autoAnswer && s.answer.mode !== 'meeting_notes' && s.answer.autoAnswerSources.includes(source as AudioSource);
  }

  /** Live text from the other side: start answering early if it already reads as a question. */
  private speculate(seg: TranscriptSegment): void {
    const text = seg.text.trim();
    if (!text) return;
    const { triage } = triageUtterance(text);
    const cur = this.spec;
    // Still the same question, unless an unfinished fragment just became complete ("…a process and a" →
    // "…a process and a thread"): then start over from the complete text so it can be shown at the pause.
    const completed = !!cur && isFragment(cur.text) && !isFragment(text);
    if (cur && cur.source === seg.source && sameQuestion(cur.text, text) && !(completed && !cur.committed)) return;
    if (cur && !cur.committed) this.deps.answer.dropPrefetch();
    if (cur?.committed && cur.source === seg.source) return; // already on screen; the final decides
    this.spec = null;
    if (triage === 'ignore') return;
    if (triage === 'check' && !this.deps.gate && !seg.isQuestion && !analyzeQuestion(text).isQuestion) return;
    const id = this.deps.answer.prefetch({ question: extractQuestion(text), origin: seg.source as AudioSource });
    const spec = { id, text, source: seg.source as AudioSource, decision: (triage === 'answer' || !this.deps.gate ? 'answer' : 'pending') as 'answer' | 'pending', committed: false, pausedAt: null as number | null };
    this.spec = spec;
    if (spec.decision === 'pending') void this.checkSpec(spec);
    // The question only became clear after they had already gone quiet: show it now.
    else if (this.pausedAt.has(spec.source) && !isFragment(spec.text)) this.revealSpec(spec, this.pausedAt.get(spec.source)!);
  }

  private async checkSpec(spec: NonNullable<SessionController['spec']>): Promise<void> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GATE_TIMEOUT_MS);
    const t0 = this.now();
    let decision: GateDecision | null;
    try {
      decision = (await this.deps.gate?.(spec.text, this.segments.slice(-12), ctl.signal)) ?? null;
    } catch {
      decision = null;
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    if (this.spec !== spec) return;
    const go = decision ? decision === 'answer' : analyzeQuestion(spec.text).isQuestion;
    this.deps.perf({ stage: 'question_gate', ms: this.now() - t0, at: this.now(), provider: null, model: null, label: `live:${decision ?? (go ? 'fallback-answer' : 'fallback-skip')}` });
    if (!go) {
      this.deps.answer.dropPrefetch();
      this.spec = null;
      return;
    }
    spec.decision = 'answer';
    const paused = spec.pausedAt ?? this.pausedAt.get(spec.source) ?? null;
    if (paused !== null && !isFragment(spec.text)) this.revealSpec(spec, paused);
  }

  /** The other side went quiet: show the early answer now if it is for this question. */
  private onPause(source: AudioSource, lastSpeechAt: number): void {
    this.pausedAt.set(source, lastSpeechAt);
    const spec = this.spec;
    if (!spec || spec.committed || spec.source !== source) return;
    if (isFragment(spec.text)) return; // a pause mid-question ("Can you tell me …"): wait for the rest
    if (spec.decision === 'pending') spec.pausedAt = lastSpeechAt;
    else this.revealSpec(spec, lastSpeechAt);
  }

  private revealSpec(spec: NonNullable<SessionController['spec']>, endedAt: number): void {
    const ok = this.deps.answer.commit(spec.id, { questionEndedAt: endedAt, question: extractQuestion(spec.text) });
    if (!ok) {
      if (this.spec === spec) this.spec = null;
      return;
    }
    spec.committed = true;
    this.candidate = { text: extractQuestion(spec.text), source: spec.source, score: analyzeQuestion(spec.text).score };
    this.candidateGen++; // an older pending check must not ask over this
    this.pushSnapshot();
  }

  private onSegmentFinal(seg: TranscriptSegment): void {
    this.segments.push(seg);
    if (this.segments.length > MAX_SEGMENTS) this.segments.splice(0, this.segments.length - MAX_SEGMENTS);
    if (this.recordHistory && this.sessionId) this.deps.history()?.segment(this.sessionId, seg);
    const s = this.deps.settings();
    const autoSource = s.answer.autoAnswer && s.answer.mode !== 'meeting_notes' && s.answer.autoAnswerSources.includes(seg.source as AudioSource);
    if (!autoSource) {
      // Never auto-answered (e.g. the user's own mic): only remembered for the manual Ask hotkey.
      if (seg.isQuestion) {
        this.candidate = { text: extractQuestion(this.withLeadIn(seg)), source: seg.source as AudioSource, score: seg.questionScore };
        this.pushSnapshot();
      }
      return;
    }
    // When the speaker actually stopped (the pause mark), not when the transcript arrived.
    const spokeUntil = this.pausedAt.get(seg.source as AudioSource) ?? seg.endedAt ?? this.now();
    this.pausedAt.delete(seg.source as AudioSource); // the utterance is over
    // An early answer from live text: keep it if the final transcript is the same question.
    const spec = this.spec;
    if (spec && spec.source === seg.source) {
      if (sameQuestion(spec.text, seg.text)) {
        if (!spec.committed && spec.decision === 'answer') this.revealSpec(spec, spokeUntil);
        else if (!spec.committed) spec.pausedAt = spokeUntil; // check still running
        if (this.spec === spec && spec.committed) this.spec = null;
        if (spec.committed || spec.decision === 'pending') return;
      } else {
        if (!spec.committed) this.deps.answer.dropPrefetch();
        this.spec = null;
      }
    }
    const { triage } = triageUtterance(seg.text);
    if (triage === 'ignore') {
      // Background talk ("wait a minute", "hey Rahul, come here"): never cancels the answer on screen.
      this.deps.perf({ stage: 'question_gate', ms: 0, at: this.now(), provider: null, model: null, label: 'ignored' });
      return;
    }
    const text = extractQuestion(this.withLeadIn(seg));
    this.candidate = { text, source: seg.source as AudioSource, score: seg.questionScore };
    this.pushSnapshot();
    const gen = ++this.candidateGen;
    this.gateCtl?.abort();
    this.gateCtl = null;
    // Short debounce: a follow-up fragment arriving immediately is merged.
    if (this.autoTimer) clearTimeout(this.autoTimer);
    const finalAt = seg.endedAt ?? this.now();
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      const c = this.candidate;
      if (!c || gen !== this.candidateGen) return;
      const ask = () => {
        if (gen !== this.candidateGen || this.state !== 'listening') return;
        this.deps.perf({ stage: 'final_to_question', ms: this.now() - finalAt, at: this.now(), provider: null, model: null, label: seg.source });
        this.deps.answer.ask({ question: c.text, origin: c.source, questionEndedAt: Math.min(finalAt, spokeUntil) });
      };
      if (triage === 'answer' || !this.deps.gate) {
        if (triage === 'answer' || seg.isQuestion) ask();
        return;
      }
      void this.checkThenAsk(c.text, seg, gen, ask);
    }, 250);
  }

  private async checkThenAsk(text: string, seg: TranscriptSegment, gen: number, ask: () => void): Promise<void> {
    const ctl = new AbortController();
    this.gateCtl = ctl;
    const t0 = this.now();
    const timer = setTimeout(() => ctl.abort(), GATE_TIMEOUT_MS);
    let decision: GateDecision | null;
    try {
      decision = (await this.deps.gate?.(text, this.segments.slice(-12), ctl.signal)) ?? null;
    } catch {
      decision = null;
    } finally {
      clearTimeout(timer);
      ctl.abort(); // closes the stream once the one-word reply is in
      if (this.gateCtl === ctl) this.gateCtl = null;
    }
    if (gen !== this.candidateGen) return;
    // No decision (offline, slow, unparsable): fall back to the deterministic score.
    const go = decision ? decision === 'answer' : seg.isQuestion;
    this.deps.perf({ stage: 'question_gate', ms: this.now() - t0, at: this.now(), provider: null, model: null, label: decision ?? (go ? 'fallback-answer' : 'fallback-skip') });
    if (go) ask();
  }

  /** Prepend a short preceding statement from the same source ("I see you used Kafka. Why?"). */
  private withLeadIn(seg: TranscriptSegment): string {
    const idx = this.segments.lastIndexOf(seg);
    const prev = idx > 0 ? this.segments[idx - 1] : undefined;
    if (
      prev &&
      prev.source === seg.source &&
      (!prev.isQuestion || isFragment(prev.text)) &&
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
    this.candidateGen++;
    this.gateCtl?.abort();
    this.gateCtl = null;
    this.deps.answer.dropPrefetch();
    this.spec = null;
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
