import type { AudioSource } from '@hirora/contracts';
import { pcmLevelDbfs, EnergyVad } from './vad';
import { StreamingTranscriber, type WhisperClient } from './streamingTranscriber';
import { TurnDetector, thresholdsFor, SAVA_FRAME_MS, SAVA_LOOKAHEAD_MS, type TurnEvent, type TurnThresholds } from './turnDetector';
import type { SpeakerRole } from './conversationContext';

export type SavaScore = { speech: number; turn: number };

export interface LiveCaptureDeps {
  source: AudioSource;
  role: SpeakerRole;
  cheap: boolean;
  client: WhisperClient;
  vocab: () => string[];
  thresholds: () => TurnThresholds;
  useSava: boolean;
  now?: () => number;
  onInterim: (committed: string, tentative: string) => void;
  onFinal: (text: string, startMs: number, endMs: number) => void;
  onPause: (lastVoiceTs: number) => void;
  onResume: () => void;
  onWindowMs: (ms: number) => void;
  /** SAVA for one 40 ms block of this source, in order. null = not loaded or failed: the energy VAD decides. */
  savaScores?: (pcm40: Buffer) => Promise<SavaScore | null> | SavaScore | null;
  /** SAVA loaded and usable right now (checked per frame, so it can come up after the session starts). */
  savaReady?: () => boolean;
}

const FRAME_MS = 20;
const SAVA_BLOCK_BYTES = (16_000 * 2 * SAVA_FRAME_MS) / 1000; // 1280
/** Audio kept from before speech is detected, so the first word isn't clipped (SAVA needs ~250 ms to confirm speech). */
export const PREROLL_MS = 500;
/** Energy fallback: VAD hangover + the detector's 80 ms guard ≈ the 300 ms pause of 0.3.1. */
const ENERGY_HANGOVER_MS = 220;

/**
 * One audio source: SAVA (or the energy VAD) decides turns, and each turn gets its own
 * sliding-window transcriber. Every 20 ms frame of a turn reaches Whisper.
 */
export class LiveCapture {
  readonly turn: TurnDetector;
  private readonly energy = new EnergyVad(9, 3, ENERGY_HANGOVER_MS);
  private readonly now: () => number;
  /** Transcriber of the turn in progress; one that is finishing its last decode is no longer here. */
  private transcriber: StreamingTranscriber | null = null;
  /** Frames since the last turn ended, up to PREROLL_MS. */
  private preroll: Buffer[] = [];
  private savaPcm = Buffer.alloc(0);
  private savaQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Text of the previous turn: context for Whisper's prompt. */
  private lastFinal = '';

  constructor(private readonly deps: LiveCaptureDeps) {
    this.now = deps.now ?? Date.now;
    this.turn = new TurnDetector(deps.thresholds());
  }

  /** The turn in progress (tests). */
  get current(): StreamingTranscriber | null {
    return this.transcriber;
  }

  /** Resolves once every queued SAVA block has been applied (tests). */
  idle(): Promise<void> {
    return this.savaQueue;
  }

  pushFrame(pcm: Buffer): void {
    if (this.disposed) return;
    const at = this.now();
    const energy = pcmLevelDbfs(pcm);
    this.turn.setThresholds(this.deps.thresholds());
    // Audio first: inside a turn every frame goes to Whisper; between turns it waits in the pre-roll.
    if (this.turn.isSpeaking && this.transcriber) this.transcriber.pushPcm(pcm, at);
    else {
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_MS / FRAME_MS) this.preroll.shift();
    }
    this.energy.push(energy, FRAME_MS, at);
    const sava = this.deps.useSava && this.deps.savaScores && (this.deps.savaReady?.() ?? true);
    if (!sava) {
      this.savaPcm = Buffer.alloc(0);
      this.handle(this.turn.pushEnergy(energy, at, this.energy.isSpeaking, this.energy.silenceMs), at);
      return;
    }
    this.savaPcm = Buffer.concat([this.savaPcm, pcm]);
    while (this.savaPcm.length >= SAVA_BLOCK_BYTES) {
      const block = this.savaPcm.subarray(0, SAVA_BLOCK_BYTES);
      this.savaPcm = this.savaPcm.subarray(SAVA_BLOCK_BYTES);
      const speaking = this.energy.isSpeaking;
      const silenceMs = this.energy.silenceMs;
      const blockDb = pcmLevelDbfs(block);
      // One block at a time, in order: SAVA's state carries from each block to the next.
      this.savaQueue = this.savaQueue.then(async () => {
        if (this.disposed) return;
        const scores = await Promise.resolve(this.deps.savaScores!(block)).catch(() => null);
        if (this.disposed) return;
        const ev = scores
          ? this.turn.push({ speech: scores.speech, turn: scores.turn, tsMs: at - SAVA_LOOKAHEAD_MS, energyDbfs: blockDb, frameMs: SAVA_FRAME_MS })
          : this.turn.pushEnergy(blockDb, at, speaking, silenceMs, SAVA_FRAME_MS);
        this.handle(ev, at);
      });
    }
  }

  private handle(ev: TurnEvent | null, at: number): void {
    if (!ev) return;
    if (ev.type === 'speechStart' || ev.type === 'resumed') {
      if (ev.type === 'resumed') this.deps.onResume();
      // A new transcriber per turn: the previous one may still be finishing its last decode.
      const t = this.newTranscriber();
      for (const f of this.preroll.splice(0)) t.pushPcm(f, at);
      t.setSpeechActive(true);
      this.transcriber = t;
      return;
    }
    if (ev.type === 'turnEnd') {
      const t = this.transcriber;
      this.transcriber = null;
      this.deps.onPause(ev.lastVoiceTs);
      if (t) void t.finalize();
    }
  }

  private newTranscriber(): StreamingTranscriber {
    const t: StreamingTranscriber = new StreamingTranscriber(
      this.deps.source,
      this.deps.client,
      {
        // Only the turn in progress updates the live line; a finishing one reports just its final text.
        interim: (e) => {
          if (t === this.transcriber) this.deps.onInterim(e.committed, e.tentative);
        },
        committedAdvanced: () => undefined,
        final: (e) => {
          this.lastFinal = e.text;
          this.deps.onFinal(e.text, e.startMs, e.endMs);
        },
        windowMs: (ms) => this.deps.onWindowMs(ms),
      },
      () => ({ vocab: this.deps.vocab(), committedHint: this.lastFinal }),
      this.now,
    );
    t.setCheap(this.deps.cheap);
    t.resetUtterance();
    return t;
  }

  dispose(): void {
    this.disposed = true;
    this.transcriber?.dispose();
    this.transcriber = null;
    this.preroll = [];
  }
}

export function savaThresholdsFromSettings(s: {
  savaAggressiveness: 'low' | 'medium' | 'high';
  speechOnThreshold: number;
  turnThreshold: number;
  turnHoldFrames: number;
  maxSilenceMs: number;
  savaMinEnergyDbfs: number;
}): TurnThresholds {
  return thresholdsFor(s.savaAggressiveness, {
    speechOnThreshold: s.speechOnThreshold,
    turnThreshold: s.turnThreshold,
    turnHoldFrames: s.turnHoldFrames,
    maxSilenceMs: s.maxSilenceMs,
    minEnergyDbfs: s.savaMinEnergyDbfs,
  });
}

export { SAVA_FRAME_MS };
