import type { AudioSource, PerfSample } from '@hirora/contracts';
import { ProviderError } from '@hirora/providers';
import type { SttOptions, SttSession, StreamingTranscriptionProvider } from '@hirora/providers';
import { EnergyVad } from './vad';

export type SttConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';

export interface SttStreamDeps {
  source: AudioSource;
  createProvider(): StreamingTranscriptionProvider | null;
  options(): SttOptions;
  /** Absolute gate in dBFS; <= -89 disables gating (always stream). */
  gateDb(): number;
  onInterim(text: string): void;
  onFinal(text: string): void;
  onUtteranceEnd(): void;
  /**
   * The speaker has been quiet for PAUSE_MS: probably done with the sentence (the VAD's
   * own end-of-speech comes later). `lastSpeechAt` is when they stopped.
   */
  onPause?(lastSpeechAt: number): void;
  /** Speech resumed after onPause (the pause was mid-sentence). */
  onResume?(): void;
  onState(state: SttConnState, error: ProviderError | null): void;
  onAudioSent(seconds: number): void;
  perf(sample: PerfSample): void;
  now?: () => number;
}

const FRAME_MS = 20;
const FRAMES_PER_CHUNK = 5; // 100 ms chunks, as recommended by both STT providers
const PREROLL_FRAMES = 15; // 300 ms kept while gated so word onsets are not clipped
const TAIL_MS = 1500;
/** Quiet time that counts as "finished the question" for revealing an early answer. */
export const PAUSE_MS = 300;
/** Quiet time after which utterance transcribers refresh their live text. */
const SILENCE_HINT_MS = 120; // keep streaming after speech so provider endpointing sees silence
const BACKLOG_CHUNKS = 10; // 1 s buffered while (re)connecting
const KEEPALIVE_MS = 8000;
const FATAL: string[] = ['invalid_key', 'permission_denied', 'quota_exceeded', 'model_not_found', 'not_configured', 'budget_exceeded'];

/**
 * One streaming-STT connection per audio source with: 20→100 ms chunking,
 * energy-VAD noise gate with pre-roll, bounded backlog while connecting,
 * hybrid end-of-speech hints, reconnect with backoff, and seamless rotation
 * before provider session limits (Gemini Live: 10 minutes).
 */
export class SttStream {
  private session: SttSession | null = null;
  private provider: StreamingTranscriptionProvider | null = null;
  private state: SttConnState = 'idle';
  private stopped = true;
  private generation = 0;
  private chunk: Buffer[] = [];
  private preroll: Buffer[] = [];
  private backlog: Buffer[] = [];
  private vad = new EnergyVad();
  private sinceSpeechMs = Infinity;
  private gateOpen = false;
  private lastSentAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private rotatePending = false;
  private openedAt = 0;
  private speechStartAt: number | null = null;
  private speechEndAt: number | null = null;
  private sentFrames = 0;
  private pauseSent = false;
  /** Last frame the VAD heard speech: when the speaker actually stopped. */
  private lastLoudAt: number | null = null;
  private silenceHinted = false;
  droppedChunks = 0;
  lastError: ProviderError | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SttStreamDeps) {
    this.now = deps.now ?? Date.now;
  }

  get connState(): SttConnState {
    return this.state;
  }

  private setState(s: SttConnState, err: ProviderError | null = null): void {
    this.state = s;
    if (err) this.lastError = err;
    this.deps.onState(s, err);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    void this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.reconnectTimer = this.rotateTimer = null;
    this.session?.close();
    this.session = null;
    this.chunk = [];
    this.backlog = [];
    this.preroll = [];
    this.flushUsage();
    this.setState('idle');
  }

  private flushUsage(): void {
    if (this.sentFrames > 0) {
      this.deps.onAudioSent((this.sentFrames * FRAME_MS) / 1000);
      this.sentFrames = 0;
    }
  }

  private async connect(isRotation: boolean): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.provider = this.deps.createProvider();
    if (!this.provider) {
      this.setState('error', new ProviderError('stt', 'not_configured', 'No API key saved for the selected transcription provider'));
      return;
    }
    if (!isRotation) this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    if (this.provider.speechEndHangoverMs && !isRotation) this.vad = new EnergyVad(9, 3, this.provider.speechEndHangoverMs);
    const t0 = this.now();
    try {
      const session = await this.provider.open(this.deps.options(), {
        onInterim: (t) => {
          if (gen !== this.generation && this.session !== session) return;
          this.markFirstText();
          this.deps.onInterim(t);
        },
        onFinalSegment: (t) => {
          this.markFirstText();
          this.deps.onFinal(t);
        },
        onUtteranceEnd: () => {
          if (this.speechEndAt !== null) {
            this.deps.perf({ stage: 'speech_end_to_final', ms: this.now() - this.speechEndAt, at: this.now(), provider: this.provider?.id ?? null, model: null, label: this.deps.source });
            this.speechEndAt = null;
          }
          this.deps.onUtteranceEnd();
        },
        onError: (e) => {
          if (this.session === session) this.handleFailure(e);
        },
        onClose: (expected) => {
          if (!expected && this.session === session && !this.stopped) {
            this.handleFailure(new ProviderError('stt', 'network', 'Transcription connection closed'));
          }
        },
      });
      if (this.stopped || gen !== this.generation) {
        session.close();
        return;
      }
      const old = this.session;
      this.session = session;
      this.openedAt = this.now();
      this.deps.perf({ stage: 'provider_preconnect', ms: this.now() - t0, at: this.now(), provider: this.provider.id, model: null, label: `stt-${this.deps.source}` });
      if (old) {
        // Rotation: let the old session finish its last utterance, then close.
        setTimeout(() => old.close(), 4000);
      }
      this.reconnectAttempt = 0;
      this.setState('open');
      for (const c of this.backlog.splice(0)) this.sendChunk(c);
      const max = this.provider.maxSessionMs;
      if (max) {
        if (this.rotateTimer) clearTimeout(this.rotateTimer);
        this.rotateTimer = setTimeout(() => this.requestRotation(), Math.max(30_000, max - 75_000));
      }
    } catch (err) {
      if (gen !== this.generation || this.stopped) return;
      this.handleFailure(err instanceof ProviderError ? err : new ProviderError('stt', 'unknown', String(err)));
    }
  }

  private markFirstText(): void {
    if (this.speechStartAt !== null) {
      this.deps.perf({ stage: 'stt_first_partial', ms: this.now() - this.speechStartAt, at: this.now(), provider: this.provider?.id ?? null, model: null, label: this.deps.source });
      this.speechStartAt = null;
    }
  }

  private requestRotation(): void {
    this.rotatePending = true;
    // Rotate at the next pause, or within 40 s at the latest.
    setTimeout(() => {
      if (this.rotatePending) this.rotateNow();
    }, 40_000);
    if (!this.vad.isSpeaking) this.rotateNow();
  }

  private rotateNow(): void {
    if (!this.rotatePending || this.stopped) return;
    this.rotatePending = false;
    void this.connect(true);
  }

  private handleFailure(err: ProviderError): void {
    if (this.stopped) return;
    this.session?.close();
    this.session = null;
    if (FATAL.includes(err.code)) {
      this.setState('error', err);
      return;
    }
    this.reconnectAttempt++;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(5, this.reconnectAttempt - 1));
    this.setState('reconnecting', err);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(false), delay);
  }

  /** Force the provider to finalize the utterance in progress (manual Ask). */
  endOfSpeech(): void {
    this.flushChunk();
    this.session?.endOfSpeech();
  }

  pushFrame(pcm: Buffer, levelDb: number): void {
    if (this.stopped) return;
    const t = this.now();
    const ev = this.vad.push(levelDb, FRAME_MS, t);
    if (ev?.type === 'speech_start') {
      this.speechStartAt = t;
      this.speechEndAt = null;
      this.pauseSent = false;
      this.silenceHinted = false;
    } else if (ev?.type === 'speech_end') {
      this.speechEndAt = t;
      // With a short hangover the utterance can end before the pause mark: still report the pause.
      if (!this.pauseSent) {
        this.pauseSent = true;
        this.deps.onPause?.(this.lastLoudAt ?? t);
      }
      // Hybrid VAD: tell the provider speech ended so it finalizes quickly.
      if (this.provider?.wantsEndOfSpeech) {
        this.flushChunk();
        this.session?.endOfSpeech();
      }
      if (this.rotatePending) this.rotateNow();
    }
    this.sinceSpeechMs = this.vad.isSpeaking ? 0 : this.sinceSpeechMs + FRAME_MS;
    if (this.vad.isSpeaking) {
      const quiet = this.vad.silenceMs;
      if (quiet === 0) this.lastLoudAt = t;
      if (quiet === 0) {
        if (this.pauseSent) this.deps.onResume?.();
        this.pauseSent = false;
        this.silenceHinted = false;
      } else {
        if (quiet >= SILENCE_HINT_MS && !this.silenceHinted) {
          this.silenceHinted = true;
          this.flushChunk();
          this.session?.silenceStarted?.();
        }
        if (quiet >= PAUSE_MS && !this.pauseSent) {
          this.pauseSent = true;
          this.deps.onPause?.(t - quiet);
        }
      }
    }

    const gate = this.deps.gateDb();
    const gatingDisabled = gate <= -89;
    const shouldSend = gatingDisabled || this.vad.isSpeaking || this.sinceSpeechMs < TAIL_MS || levelDb > gate + 20;
    if (!shouldSend) {
      if (this.gateOpen) {
        this.flushChunk();
        this.gateOpen = false;
      }
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (this.session && t - this.lastSentAt > KEEPALIVE_MS) {
        // Tiny silence keepalive so idle provider sessions are not dropped.
        this.sendChunk(Buffer.alloc(3200));
      }
      return;
    }
    if (!this.gateOpen) {
      this.gateOpen = true;
      for (const f of this.preroll.splice(0)) this.addFrame(f);
    }
    this.addFrame(pcm);
  }

  private addFrame(pcm: Buffer): void {
    this.chunk.push(pcm);
    if (this.chunk.length >= FRAMES_PER_CHUNK) this.flushChunk();
  }

  private flushChunk(): void {
    if (this.chunk.length === 0) return;
    const buf = Buffer.concat(this.chunk);
    this.chunk = [];
    if (!this.session || !this.session.isOpen) {
      this.backlog.push(buf);
      if (this.backlog.length > BACKLOG_CHUNKS) {
        this.backlog.shift();
        this.droppedChunks++;
      }
      return;
    }
    this.sendChunk(buf);
  }

  private sendChunk(buf: Buffer): void {
    if (!this.session) return;
    if (this.session.sendAudio(buf)) {
      this.lastSentAt = this.now();
      this.sentFrames += buf.byteLength / 640;
      if (this.sentFrames >= 3000) this.flushUsage(); // report every ~60 s of audio
    } else {
      this.droppedChunks++;
    }
  }

  get sessionAgeMs(): number {
    return this.session ? this.now() - this.openedAt : 0;
  }
}
