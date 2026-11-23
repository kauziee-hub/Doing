/**
 * Live transcription of one turn with LocalAgreement-2: every tick re-decodes the whole turn so
 * far, and the words two decodes in a row agree on are committed (they never change again); the
 * rest is shown as tentative. Measured on whisper.cpp (large-v3-turbo, RTX 4060): a decode takes
 * the same ~0.2 s for 0.5 s or 15 s of audio (the encoder always runs a 30 s block), and its word
 * timestamps are too rough to cut windows on (zero-length words; a cut mid-word turned "a process"
 * into "the process"). So the turn is decoded whole, up to WHOLE_TURN_MS; LiveCapture ends longer
 * turns. The end-of-turn decode is the final text.
 */
export const STREAMING_TICK_MS = 350;
/** A decode counts as the final text if its audio reaches this far past the end of speech. */
export const FINAL_COVER_MS = 40;
/** Longest turn decoded in one piece (whisper.cpp's window is 30 s). */
export const WHOLE_TURN_MS = 28_000;
/** Kept for older callers: a turn is decoded whole, up to WHOLE_TURN_MS. */
export const MAX_WINDOW_MS = WHOLE_TURN_MS;
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

export interface HypothesisWord {
  text: string;
  /** Position in the turn (ms when whisper gave times, otherwise just the word order). */
  startMs: number;
  endMs: number;
}

export interface WhisperDecodeResult {
  text: string;
  words: HypothesisWord[];
  /** True when words came from whisper-server verbose_json with times. */
  wordTimestamps: boolean;
}

export interface WhisperDecodeRequest {
  pcm: Buffer;
  /** Start of this PCM in the turn (ms); 0, since turns are decoded whole. */
  windowStartMs: number;
  prompt: string;
  source: 'mic' | 'system' | 'app';
  /** Interim ticks: mic is low (skipped while system audio is decoding). The end-of-turn decode is final and waits. */
  priority: 'high' | 'low' | 'final';
  beamSize?: number;
  /** Ask whisper-server for word times (verbose_json). Off: plain json, faster. */
  wordTimestamps?: boolean;
}

export interface WhisperClient {
  decode(req: WhisperDecodeRequest): Promise<WhisperDecodeResult | null>;
}

export interface StreamingEvents {
  interim(ev: { committed: string; tentative: string }): void;
  committedAdvanced(committedText: string): void;
  final(ev: { text: string; startMs: number; endMs: number }): void;
  windowMs(ms: number): void;
  /**
   * Timing of each decode (no text): how long it took, and for the final one how long it waited
   * for a decode in flight. `reused`: the final text is the last decode, which already covered the
   * end of speech, so no decode ran at the end of the turn.
   */
  decoded?(ev: { ms: number; final: boolean; waitedMs: number; audioMs: number; ok: boolean; reused?: boolean }): void;
}

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .trim();
}

export function tokenizeDisplay(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Drop a hypothesis that is the same short phrase repeated 3+ times. */
export function isRepetitiveHallucination(text: string): boolean {
  const words = tokenizeDisplay(text).map(normalizeWord).filter(Boolean);
  if (words.length < 6) return false;
  for (let n = 1; n <= 6; n++) {
    const unit = words.slice(0, n).join(' ');
    if (!unit) continue;
    let repeats = 0;
    let i = 0;
    while (i + n <= words.length && words.slice(i, i + n).join(' ') === unit) {
      repeats++;
      i += n;
    }
    if (repeats >= 3 && i >= words.length * 0.85) return true;
  }
  return false;
}

export function longestCommonPrefix(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export function joinWords(words: HypothesisWord[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clipWhisperPrompt(vocab: string[], context: string, maxTokens = 224): string {
  // whisper.cpp initial_prompt is truncated at ~224 tokens; estimate 1 token ≈ 4 chars.
  const maxChars = Math.max(80, maxTokens * 4);
  const list = vocab
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 80)
    .join(', ');
  const tail = context.slice(-200);
  const raw = [list, tail].filter(Boolean).join('\n');
  return raw.length <= maxChars ? raw : raw.slice(raw.length - maxChars);
}

function wordsFromResult(result: WhisperDecodeResult): HypothesisWord[] {
  if (result.words.length && result.wordTimestamps) return result.words.map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text);
  // Words in order are all LocalAgreement needs.
  return tokenizeDisplay(result.text).map((text, i) => ({ text, startMs: i, endMs: i + 1 }));
}

export class StreamingTranscriber {
  private pcm: Buffer = Buffer.alloc(0);
  private committed: HypothesisWord[] = [];
  /** Previous hypothesis (normalized) for LocalAgreement-2. */
  private previousNorm: string[] = [];
  /** Latest uncommitted words, kept in case the end-of-turn decode fails. */
  private tentative: HypothesisWord[] = [];
  private finalText: string | null = null;
  private inflight: Promise<'ran' | 'skipped'> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private speechActive = false;
  private cheap = false;
  private startedAt: number | null = null;
  private finalWaitMs = 0;
  /** When the newest frame in the buffer arrived. */
  private lastPushAt = 0;
  /** Text of the last decode and when the newest frame it heard arrived. */
  private lastHyp: { text: string; coversUntil: number } | null = null;
  private quietPending = false;

  constructor(
    private readonly source: 'mic' | 'system' | 'app',
    private readonly client: WhisperClient,
    private readonly events: StreamingEvents,
    /** Whisper prompt: vocabulary and the text before this turn. Never this turn's own words: Whisper would skip them. */
    private readonly prompt: () => { vocab: string[]; committedHint: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** Your own mic: no interim ticks, one decode at the end of the turn. */
  setCheap(cheap: boolean): void {
    this.cheap = cheap;
    if (cheap) this.stopTicks();
  }

  get committedText(): string {
    return joinWords(this.committed);
  }

  get inflightRequest(): boolean {
    return this.inflight !== null;
  }

  get bufferedWindowMs(): number {
    return this.pcm.length / BYTES_PER_MS;
  }

  resetUtterance(): void {
    this.pcm = Buffer.alloc(0);
    this.committed = [];
    this.previousNorm = [];
    this.tentative = [];
    this.finalText = null;
    this.startedAt = null;
    this.lastHyp = null;
    this.quietPending = false;
  }

  pushPcm(pcm16: Buffer, atMs: number): void {
    if (this.startedAt === null) this.startedAt = atMs;
    this.lastPushAt = atMs;
    this.pcm = Buffer.concat([this.pcm, pcm16]);
    // LiveCapture ends a turn before this; keep the latest WHOLE_TURN_MS if a caller doesn't.
    const cap = WHOLE_TURN_MS * BYTES_PER_MS;
    if (this.pcm.length > cap) this.pcm = this.pcm.subarray(this.pcm.length - cap);
  }

  setSpeechActive(active: boolean): void {
    this.speechActive = active;
    if (active && !this.cheap) this.startTicks();
    else if (!active) this.stopTicks();
  }

  private startTicks(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => void this.tick(), STREAMING_TICK_MS);
    (this.tickTimer as { unref?: () => void }).unref?.();
  }

  private stopTicks(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  async tick(): Promise<'ran' | 'skipped'> {
    if (this.cheap || !this.speechActive || this.inflight) return 'skipped';
    if (this.pcm.length < SAMPLE_RATE) return 'skipped'; // wait for 0.5 s of audio
    return this.runDecode(this.pcm, false);
  }

  /**
   * The speaker just went quiet: decode now rather than at the next tick, as 0.3.1 does. If they
   * have finished, this decode already holds the whole question and becomes the final text.
   */
  decodeNow(): Promise<'ran' | 'skipped'> {
    // A decode in flight started before the speaker went quiet: run another as soon as it ends.
    if (this.inflight) this.quietPending = true;
    return this.tick();
  }

  /**
   * End of turn: waits for a decode in flight. If the last decode heard audio up to FINAL_COVER_MS
   * past `lastVoiceAt` (the end of speech), its text is the final one; otherwise the whole turn is
   * decoded once more (padded to 1 s). If that decode fails, the last decode's words are kept.
   */
  async finalize(lastVoiceAt?: number): Promise<string> {
    this.stopTicks();
    this.speechActive = false;
    const waitFrom = this.now();
    while (this.inflight) await this.inflight;
    this.finalWaitMs = this.now() - waitFrom;
    const covered = lastVoiceAt !== undefined && this.lastHyp && this.lastHyp.coversUntil >= lastVoiceAt + FINAL_COVER_MS;
    if (covered && this.lastHyp!.text) {
      this.finalText = this.lastHyp!.text;
      this.events.decoded?.({ ms: 0, final: true, waitedMs: this.finalWaitMs, audioMs: this.pcm.length / BYTES_PER_MS, ok: true, reused: true });
    } else if (this.pcm.length) {
      const minBytes = SAMPLE_RATE * 2; // 1 s: whisper.cpp ignores clips much shorter than that
      const pcm = this.pcm.length >= minBytes ? this.pcm : Buffer.concat([this.pcm, Buffer.alloc(minBytes - this.pcm.length)]);
      await this.runDecode(pcm, true);
    }
    const text = this.finalText ?? joinWords([...this.committed, ...this.tentative]);
    this.tentative = [];
    const startMs = this.startedAt ?? this.now();
    if (text) this.events.final({ text, startMs, endMs: startMs + this.pcm.length / BYTES_PER_MS });
    return text;
  }

  dispose(): void {
    this.stopTicks();
    this.pcm = Buffer.alloc(0);
  }

  private runDecode(pcm: Buffer, final: boolean): Promise<'ran' | 'skipped'> {
    if (this.inflight) return Promise.resolve('skipped');
    this.events.windowMs(pcm.length / BYTES_PER_MS);
    const run = (async (): Promise<'ran' | 'skipped'> => {
      const p = this.prompt();
      const t0 = this.now();
      const coversUntil = this.lastPushAt;
      const result = await this.client.decode({
        pcm,
        windowStartMs: 0,
        prompt: clipWhisperPrompt(p.vocab, p.committedHint),
        source: this.source,
        priority: final ? 'final' : this.source === 'mic' ? 'low' : 'high',
        wordTimestamps: false,
      });
      this.events.decoded?.({ ms: this.now() - t0, final, waitedMs: final ? this.finalWaitMs : 0, audioMs: pcm.length / BYTES_PER_MS, ok: !!result });
      if (!result || isRepetitiveHallucination(result.text)) return 'ran';
      if (final) {
        const text = tokenizeDisplay(result.text).join(' ');
        if (text) this.finalText = text;
        return 'ran';
      }
      this.lastHyp = { text: tokenizeDisplay(result.text).join(' '), coversUntil };
      this.applyHypothesis(wordsFromResult(result), false, result.wordTimestamps);
      return 'ran';
    })().catch((): 'ran' => 'ran');
    this.inflight = run;
    return run.finally(() => {
      if (this.inflight === run) this.inflight = null;
      // The speaker went quiet while this one was running: decode again now, not at the next tick.
      if (this.quietPending && !final) {
        this.quietPending = false;
        void this.tick();
      }
    });
  }

  /**
   * LocalAgreement-2 over whole-turn hypotheses: the prefix this hypothesis shares with the
   * previous one is committed once it is longer than what is committed, and only while it still
   * starts with the committed words (they never change). `commitAll` commits the whole hypothesis.
   */
  applyHypothesis(hyp: HypothesisWord[], commitAll: boolean, _wordTimestamps: boolean): void {
    const words = hyp.filter((w) => normalizeWord(w.text));
    const norm = words.map((w) => normalizeWord(w.text));
    const keepsCommitted = this.committed.every((c, i) => normalizeWord(c.text) === norm[i]);
    if (commitAll) {
      if (keepsCommitted) this.committed.push(...words.slice(this.committed.length));
      else this.committed = words;
      this.events.committedAdvanced(this.committedText);
      this.previousNorm = norm;
      this.tentative = [];
      this.events.interim({ committed: this.committedText, tentative: '' });
      return;
    }
    if (keepsCommitted) {
      const lcp = longestCommonPrefix(this.previousNorm, norm);
      if (lcp > this.committed.length) {
        this.committed.push(...words.slice(this.committed.length, lcp));
        this.events.committedAdvanced(this.committedText);
      }
    }
    this.previousNorm = norm;
    this.tentative = words.slice(Math.min(this.committed.length, words.length));
    this.events.interim({ committed: this.committedText, tentative: joinWords(this.tentative) });
  }
}
