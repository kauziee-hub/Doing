import type { AudioSource } from '@hirora/contracts';
import { pcmLevelDbfs, EnergyVad } from './vad';
import { StreamingTranscriber, type WhisperClient } from './streamingTranscriber';
import { TurnDetector, thresholdsFor, SAVA_FRAME_MS, type TurnThresholds } from './turnDetector';
import type { SpeakerRole } from './conversationContext';

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
  savaScores?: (pcm: Buffer, energyDbfs: number) => { speech: number; turn: number } | null;
}

const FRAME_MS = 20;

/**
 * One audio source: SAVA or energy VAD + sliding-window transcriber.
 */
export class LiveCapture {
  readonly transcriber: StreamingTranscriber;
  readonly turn: TurnDetector;
  private readonly energy = new EnergyVad(9, 3, 300);
  private savaPcm = Buffer.alloc(0);
  private streamMs = 0;
  private readonly now: () => number;

  constructor(private readonly deps: LiveCaptureDeps) {
    this.now = deps.now ?? Date.now;
    this.turn = new TurnDetector(deps.thresholds());
    this.transcriber = new StreamingTranscriber(
      deps.source,
      deps.client,
      {
        interim: (e) => deps.onInterim(e.committed, e.tentative),
        committedAdvanced: () => undefined,
        final: (e) => deps.onFinal(e.text, e.startMs, e.endMs),
        windowMs: (ms) => deps.onWindowMs(ms),
      },
      () => ({ vocab: deps.vocab(), committedHint: this.transcriber.committedText }),
      this.now,
    );
    this.transcriber.setCheap(deps.cheap);
  }

  pushFrame(pcm: Buffer): void {
    const energy = pcmLevelDbfs(pcm);
    this.streamMs += FRAME_MS;
    this.turn.setThresholds(this.deps.thresholds());
    let ev = null;
    if (this.deps.useSava && this.deps.savaScores) {
      this.savaPcm = Buffer.concat([this.savaPcm, pcm]);
      while (this.savaPcm.length >= 1280) {
        const frame = this.savaPcm.subarray(0, 1280);
        this.savaPcm = this.savaPcm.subarray(1280);
        const scores = this.deps.savaScores(frame, energy);
        if (scores) {
          ev = this.turn.push({
            speech: scores.speech,
            turn: scores.turn,
            tsMs: this.now() - 120,
            energyDbfs: energy,
          });
          this.handleTurn(ev, pcm, energy);
        } else {
          this.energyPush(pcm, energy);
        }
      }
      return;
    }
    this.energyPush(pcm, energy);
  }

  private energyPush(pcm: Buffer, energy: number): void {
    this.energy.push(energy, FRAME_MS, this.now());
    const ev = this.turn.pushEnergy(energy, this.now(), this.energy.isSpeaking, this.energy.silenceMs === Infinity ? 9999 : this.energy.silenceMs);
    this.handleTurn(ev, pcm, energy);
  }

  private handleTurn(
    ev: { type: string; at?: number; lastVoiceTs?: number } | null,
    pcm: Buffer,
    _energy: number,
  ): void {
    if (ev?.type === 'speechStart' || ev?.type === 'resumed') {
      if (ev.type === 'speechStart') this.transcriber.resetUtterance();
      this.transcriber.setSpeechActive(true);
      if (ev.type === 'resumed') this.deps.onResume();
    }
    if (this.turn.isSpeaking || ev?.type === 'speechActive' || ev?.type === 'speechStart' || ev?.type === 'resumed') {
      this.transcriber.pushPcm(pcm, this.now());
    }
    if (ev?.type === 'turnEnd') {
      this.transcriber.setSpeechActive(false);
      this.deps.onPause(ev.lastVoiceTs ?? this.now());
      void this.transcriber.finalize();
    }
  }

  dispose(): void {
    this.transcriber.dispose();
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
