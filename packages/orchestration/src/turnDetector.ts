/**
 * End-of-turn policy over SAVA (or energy-VAD fallback) 40 ms frames.
 * Does not depend on the upstream sava.Policy — thresholds are ours.
 */
export const SAVA_FRAME_MS = 40;
export const SAVA_LOOKAHEAD_MS = 120;
/** A turn is decoded whole (StreamingTranscriber.WHOLE_TURN_MS = 28 s): end it just before. */
export const MAX_UTTERANCE_MS = 27_000;

export type TurnAggressiveness = 'low' | 'medium' | 'high';

export interface TurnThresholds {
  speechOnThreshold: number;
  turnThreshold: number;
  turnHoldFrames: number;
  minSpeechMs: number;
  minSilenceGuardMs: number;
  maxSilenceMs: number;
  resumeWindowMs: number;
  minEnergyDbfs: number;
}

export const AGGRESSIVENESS: Record<TurnAggressiveness, Pick<TurnThresholds, 'speechOnThreshold' | 'turnThreshold' | 'turnHoldFrames' | 'maxSilenceMs'>> = {
  low: { speechOnThreshold: 0.6, turnThreshold: 0.65, turnHoldFrames: 3, maxSilenceMs: 1600 },
  medium: { speechOnThreshold: 0.5, turnThreshold: 0.5, turnHoldFrames: 2, maxSilenceMs: 1200 },
  high: { speechOnThreshold: 0.4, turnThreshold: 0.4, turnHoldFrames: 2, maxSilenceMs: 800 },
};

export function thresholdsFor(preset: TurnAggressiveness, override: Partial<TurnThresholds> = {}): TurnThresholds {
  return {
    minSpeechMs: 250,
    minSilenceGuardMs: 80,
    resumeWindowMs: 400,
    minEnergyDbfs: -50,
    ...AGGRESSIVENESS[preset],
    ...override,
  };
}

export interface SavaFrame {
  /** P(speech) already using the 120 ms lookahead head when available. */
  speech: number;
  turn: number;
  /** Frame time in stream ms (after shifting speech back by lookahead). */
  tsMs: number;
  energyDbfs: number;
  /** Audio this update covers: 40 ms for SAVA, 20 ms for the energy fallback. */
  frameMs?: number;
  /** When the voice was last heard, if earlier than tsMs (the energy VAD's hangover). */
  voiceTs?: number;
}

export type TurnEvent =
  | { type: 'speechStart'; at: number }
  | { type: 'speechActive'; at: number }
  | { type: 'turnEnd'; lastVoiceTs: number }
  | { type: 'resumed'; at: number };

export class TurnDetector {
  private speaking = false;
  private speechFrames = 0;
  private voicedMs = 0;
  private lowSpeechMs = 0;
  private turnHold = 0;
  private utteranceMs = 0;
  private lastVoiceTs = 0;
  private endedAt: number | null = null;
  private startedAt: number | null = null;

  constructor(private thresholds: TurnThresholds) {}

  setThresholds(t: TurnThresholds): void {
    this.thresholds = t;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.speaking = false;
    this.speechFrames = 0;
    this.voicedMs = 0;
    this.lowSpeechMs = 0;
    this.turnHold = 0;
    this.utteranceMs = 0;
    this.endedAt = null;
    this.startedAt = null;
  }

  push(frame: SavaFrame): TurnEvent | null {
    const t = this.thresholds;
    const step = frame.frameMs ?? SAVA_FRAME_MS;
    const loudEnough = frame.energyDbfs >= t.minEnergyDbfs;
    const speech = loudEnough && frame.speech >= t.speechOnThreshold;
    if (!this.speaking) {
      if (this.endedAt !== null && frame.tsMs - this.endedAt <= t.resumeWindowMs && speech) {
        this.speaking = true;
        this.endedAt = null;
        this.lowSpeechMs = 0;
        this.turnHold = 0;
        this.lastVoiceTs = frame.voiceTs ?? frame.tsMs;
        return { type: 'resumed', at: frame.tsMs };
      }
      this.speechFrames = speech ? this.speechFrames + 1 : 0;
      if (this.speechFrames >= 2) {
        this.speaking = true;
        this.startedAt = frame.tsMs;
        this.voicedMs = step * 2;
        this.utteranceMs = this.voicedMs;
        this.lastVoiceTs = frame.voiceTs ?? frame.tsMs;
        this.endedAt = null;
        return { type: 'speechStart', at: frame.tsMs };
      }
      return null;
    }
    this.utteranceMs += step;
    if (speech) {
      this.voicedMs += step;
      this.lowSpeechMs = 0;
      this.turnHold = 0;
      this.lastVoiceTs = frame.voiceTs ?? frame.tsMs;
      if (this.utteranceMs >= MAX_UTTERANCE_MS && this.voicedMs >= t.minSpeechMs) {
        return this.end(frame.tsMs);
      }
      return { type: 'speechActive', at: frame.tsMs };
    }
    this.lowSpeechMs += step;
    if (frame.turn >= t.turnThreshold) this.turnHold += 1;
    else this.turnHold = 0;
    const turnOk = this.turnHold >= t.turnHoldFrames && this.lowSpeechMs >= t.minSilenceGuardMs;
    const silenceOk = this.lowSpeechMs >= t.maxSilenceMs;
    if ((turnOk || silenceOk) && this.voicedMs >= t.minSpeechMs) return this.end(this.lastVoiceTs);
    if (this.utteranceMs >= MAX_UTTERANCE_MS && this.voicedMs >= t.minSpeechMs) return this.end(this.lastVoiceTs);
    return { type: 'speechActive', at: frame.tsMs };
  }

  /**
   * Energy-VAD fallback, one 20 ms frame per call. The VAD's own hangover (300 ms) decides the
   * pause, as in 0.3.1: speech while it says speaking, end of turn once it stops. The level gate
   * is skipped during the hangover, where quiet frames are expected.
   */
  pushEnergy(levelDbfs: number, tsMs: number, speaking: boolean, silenceMs: number, frameMs = 20): TurnEvent | null {
    return this.push({
      speech: speaking ? 0.9 : 0.05,
      turn: speaking ? 0.05 : 0.9,
      tsMs,
      energyDbfs: speaking ? 0 : levelDbfs,
      frameMs,
      // The pause mark is when the voice stopped, not when the hangover ran out.
      voiceTs: speaking && Number.isFinite(silenceMs) ? tsMs - silenceMs : undefined,
    });
  }

  private end(lastVoiceTs: number): TurnEvent {
    this.speaking = false;
    this.speechFrames = 0;
    this.voicedMs = 0;
    this.lowSpeechMs = 0;
    this.turnHold = 0;
    this.utteranceMs = 0;
    this.endedAt = lastVoiceTs;
    return { type: 'turnEnd', lastVoiceTs };
  }
}
