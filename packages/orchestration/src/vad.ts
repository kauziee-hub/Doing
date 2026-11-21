/** dBFS of a PCM16LE buffer. */
export function pcmLevelDbfs(pcm: Buffer | Uint8Array): number {
  const n = Math.floor(pcm.byteLength / 2);
  if (n === 0) return -100;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return rms <= 1e-5 ? -100 : 20 * Math.log10(rms);
}

export interface VadEvent {
  type: 'speech_start' | 'speech_end';
  /** Monotonic time (ms) of the frame that triggered the transition. */
  at: number;
}

/**
 * Adaptive energy VAD with hangover. Tracks a noise floor and declares speech
 * when energy exceeds floor + margin for `startFrames` consecutive frames; speech
 * ends after `hangoverMs` of sub-threshold frames. Used for (a) the noise gate
 * that avoids streaming long silences to paid STT and (b) hybrid end-of-speech
 * hints that let providers finalize faster. Provider-side VAD remains the fallback.
 */
export class EnergyVad {
  private floor = -60;
  private speaking = false;
  private aboveCount = 0;
  private silentMs = 0;

  constructor(
    private readonly marginDb = 9,
    private readonly startFrames = 3,
    private readonly hangoverMs = 450,
    private readonly absoluteMinDb = -58,
  ) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get noiseFloorDb(): number {
    return this.floor;
  }

  /** Feed one frame's level. Returns a transition event or null. */
  push(levelDb: number, frameMs: number, at: number): VadEvent | null {
    const threshold = Math.max(this.floor + this.marginDb, this.absoluteMinDb);
    const loud = levelDb > threshold;
    if (!this.speaking) {
      // Track floor only when not speaking: fast down, slow up.
      this.floor = levelDb < this.floor ? this.floor * 0.7 + levelDb * 0.3 : this.floor * 0.995 + levelDb * 0.005;
      this.floor = Math.max(-95, Math.min(-25, this.floor));
      this.aboveCount = loud ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= this.startFrames) {
        this.speaking = true;
        this.silentMs = 0;
        return { type: 'speech_start', at };
      }
      return null;
    }
    if (loud) {
      this.silentMs = 0;
      return null;
    }
    this.silentMs += frameMs;
    if (this.silentMs >= this.hangoverMs) {
      this.speaking = false;
      this.aboveCount = 0;
      return { type: 'speech_end', at };
    }
    return null;
  }
}
