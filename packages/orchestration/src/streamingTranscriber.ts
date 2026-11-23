/**
 * LocalAgreement-style streaming transcription over whisper.cpp utterance
 * windows. One instance per audio source. Committed words never change.
 */
export const STREAMING_TICK_MS = 350;
export const WINDOW_OVERLAP_MS = 200;
export const MAX_WINDOW_MS = 15_000;
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

export interface HypothesisWord {
  text: string;
  /** Absolute utterance time (ms from utterance start). */
  startMs: number;
  endMs: number;
}

export interface WhisperDecodeResult {
  text: string;
  words: HypothesisWord[];
  /** True when words came from whisper-server verbose_json; false = segment fallback. */
  wordTimestamps: boolean;
}

export interface WhisperDecodeRequest {
  pcm: Buffer;
  /** Absolute start of this PCM slice in the utterance (ms). */
  windowStartMs: number;
  prompt: string;
  source: 'mic' | 'system' | 'app';
  /** Mic uses lowest priority; skipped if a system request is in flight. */
  priority: 'high' | 'low';
  beamSize?: number;
}

export interface WhisperClient {
  decode(req: WhisperDecodeRequest): Promise<WhisperDecodeResult | null>;
}

export interface StreamingEvents {
  interim(ev: { committed: string; tentative: string }): void;
  committedAdvanced(committedText: string): void;
  final(ev: { text: string; startMs: number; endMs: number }): void;
  windowMs(ms: number): void;
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

export function clipWhisperPrompt(vocab: string[], committed: string, maxTokens = 224): string {
  // whisper.cpp initial_prompt is truncated at ~224 tokens; estimate 1 token ≈ 4 chars.
  const maxChars = Math.max(80, maxTokens * 4);
  const list = vocab
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 80)
    .join(', ');
  const tail = committed.slice(-200);
  const raw = [list, tail].filter(Boolean).join('\n');
  return raw.length <= maxChars ? raw : raw.slice(raw.length - maxChars);
}

function wordsFromResult(result: WhisperDecodeResult, windowStartMs: number): HypothesisWord[] {
  if (result.words.length) {
    return result.words.map((w) => ({
      text: w.text.trim(),
      startMs: windowStartMs + w.startMs,
      endMs: windowStartMs + w.endMs,
    })).filter((w) => w.text);
  }
  const tokens = tokenizeDisplay(result.text);
  // No timestamps: treat the whole window as one commit unit (segment granularity).
  if (!tokens.length) return [];
  return [
    {
      text: result.text.trim(),
      startMs: windowStartMs,
      endMs: windowStartMs + 1,
    },
  ];
}

export class StreamingTranscriber {
  private pcm: Buffer = Buffer.alloc(0);
  /** Length of pcm in ms from utterance start, including dropped prefix. */
  private originMs = 0;
  private committed: HypothesisWord[] = [];
  /** Last full hypothesis (normalized), for LocalAgreement-2 when the window still includes the start. */
  private previousFullNorm: string[] = [];
  /** Uncommitted tail of the last windowed hypothesis. */
  private previousRemNorm: string[] = [];
  private utteranceStartMs: number | null = null;
  private lastVoiceMs = 0;
  private inflight = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private speechActive = false;
  private cheap = false;

  constructor(
    private readonly source: 'mic' | 'system' | 'app',
    private readonly client: WhisperClient,
    private readonly events: StreamingEvents,
    private readonly prompt: () => { vocab: string[]; committedHint: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** Mic "me" turns: no interim ticks, one decode at turn end. */
  setCheap(cheap: boolean): void {
    this.cheap = cheap;
    if (cheap) this.stopTicks();
  }

  get committedText(): string {
    return joinWords(this.committed);
  }

  get lastCommittedEndMs(): number {
    return this.committed.length ? this.committed[this.committed.length - 1]!.endMs : 0;
  }

  get inflightRequest(): boolean {
    return this.inflight;
  }

  get bufferedWindowMs(): number {
    return this.pcm.length / BYTES_PER_MS;
  }

  resetUtterance(): void {
    this.pcm = Buffer.alloc(0);
    this.originMs = 0;
    this.committed = [];
    this.previousFullNorm = [];
    this.previousRemNorm = [];
    this.utteranceStartMs = this.now();
    this.lastVoiceMs = 0;
  }

  pushPcm(pcm16: Buffer, atMs: number): void {
    if (this.utteranceStartMs === null) this.utteranceStartMs = atMs;
    this.pcm = Buffer.concat([this.pcm, pcm16]);
    this.lastVoiceMs = this.originMs + this.pcm.length / BYTES_PER_MS;
    const cap = (MAX_WINDOW_MS + WINDOW_OVERLAP_MS + 2000) * BYTES_PER_MS;
    if (this.pcm.length > cap) {
      const drop = this.pcm.length - cap;
      this.pcm = this.pcm.subarray(drop);
      this.originMs += drop / BYTES_PER_MS;
    }
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

  private windowSlice(): { pcm: Buffer; windowStartMs: number } | null {
    const overlap = WINDOW_OVERLAP_MS;
    const startMs = Math.max(0, this.lastCommittedEndMs - overlap);
    const skipBytes = Math.max(0, Math.floor((startMs - this.originMs) * BYTES_PER_MS));
    let slice = this.pcm.subarray(Math.min(skipBytes, this.pcm.length));
    const maxBytes = MAX_WINDOW_MS * BYTES_PER_MS;
    if (slice.length > maxBytes) slice = slice.subarray(slice.length - maxBytes);
    if (slice.length < SAMPLE_RATE) return null; // < 0.5 s
    const windowStartMs = startMs + Math.max(0, skipBytes / BYTES_PER_MS - (startMs - this.originMs));
    const actualStart = this.originMs + (this.pcm.length - slice.length) / BYTES_PER_MS;
    this.events.windowMs(slice.length / BYTES_PER_MS);
    return { pcm: slice, windowStartMs: actualStart };
  }

  async tick(): Promise<'ran' | 'skipped'> {
    if (this.cheap || !this.speechActive) return 'skipped';
    if (this.inflight) return 'skipped';
    const win = this.windowSlice();
    if (!win) return 'skipped';
    return this.runDecode(win, false);
  }

  /** Final decode of the uncommitted tail; commits everything. */
  async finalize(): Promise<string> {
    this.stopTicks();
    const win = this.windowSlice();
    if (win) await this.runDecode(win, true);
    const text = this.committedText;
    const startMs = this.committed[0]?.startMs ?? 0;
    const endMs = this.lastCommittedEndMs;
    if (text) this.events.final({ text, startMs, endMs });
    return text;
  }

  dispose(): void {
    this.stopTicks();
    this.pcm = Buffer.alloc(0);
  }

  private async runDecode(win: { pcm: Buffer; windowStartMs: number }, commitAll: boolean): Promise<'ran' | 'skipped'> {
    if (this.inflight) return 'skipped';
    this.inflight = true;
    try {
      const p = this.prompt();
      const result = await this.client.decode({
        pcm: win.pcm,
        windowStartMs: win.windowStartMs,
        prompt: clipWhisperPrompt(p.vocab, p.committedHint || this.committedText),
        source: this.source,
        priority: this.source === 'mic' ? 'low' : 'high',
      });
      if (!result || isRepetitiveHallucination(result.text)) return 'ran';
      this.applyHypothesis(wordsFromResult(result, win.windowStartMs), commitAll, result.wordTimestamps);
      return 'ran';
    } finally {
      this.inflight = false;
    }
  }

  applyHypothesis(hyp: HypothesisWord[], commitAll: boolean, wordTimestamps: boolean): void {
    const rem = hyp.filter((w) => w.endMs > this.lastCommittedEndMs && normalizeWord(w.text));
    const remNorm = rem.map((w) => normalizeWord(w.text));
    if (!rem.length) {
      this.events.interim({ committed: this.committedText, tentative: '' });
      return;
    }
    if (commitAll) {
      this.committed.push(...rem);
      this.previousRemNorm = [];
      this.events.committedAdvanced(this.committedText);
      this.trimAudio();
      this.events.interim({ committed: this.committedText, tentative: '' });
      return;
    }
    if (!wordTimestamps) {
      const lcp = longestCommonPrefix(this.previousRemNorm, remNorm);
      this.previousRemNorm = remNorm;
      if (lcp === remNorm.length && remNorm.length > 0) {
        this.committed.push(...rem);
        this.events.committedAdvanced(this.committedText);
        this.previousRemNorm = [];
        this.trimAudio();
        this.events.interim({ committed: this.committedText, tentative: '' });
        return;
      }
      this.events.interim({ committed: this.committedText, tentative: joinWords(rem) });
      return;
    }
    const hypNorm = hyp.map((w) => normalizeWord(w.text)).filter(Boolean);
    const prefixMatch =
      this.committed.length === 0 ||
      (hyp.length >= this.committed.length &&
        this.committed.every((c, i) => normalizeWord(c.text) === normalizeWord(hyp[i]?.text ?? '')));
    if (prefixMatch) {
      const lcp = longestCommonPrefix(this.previousFullNorm, hypNorm);
      if (lcp > this.committed.length) {
        this.committed.push(...hyp.slice(this.committed.length, lcp));
        this.events.committedAdvanced(this.committedText);
        this.trimAudio();
      }
      this.previousFullNorm = hypNorm;
      this.previousRemNorm = hypNorm.slice(this.committed.length);
      this.events.interim({ committed: this.committedText, tentative: joinWords(hyp.slice(this.committed.length)) });
      return;
    }
    const windowed = (hyp[0]?.startMs ?? 0) > 0 && hyp[0]!.startMs >= this.lastCommittedEndMs - WINDOW_OVERLAP_MS;
    if (windowed) {
      const lcp = longestCommonPrefix(this.previousRemNorm, remNorm);
      if (lcp > 0) {
        this.committed.push(...rem.slice(0, lcp));
        this.events.committedAdvanced(this.committedText);
        this.trimAudio();
      }
      this.previousRemNorm = remNorm.slice(lcp);
      this.events.interim({ committed: this.committedText, tentative: joinWords(rem.slice(lcp)) });
      return;
    }
    this.events.interim({ committed: this.committedText, tentative: joinWords(rem) });
  }

  private trimAudio(): void {
    const keepFrom = Math.max(0, this.lastCommittedEndMs - WINDOW_OVERLAP_MS);
    const skip = Math.max(0, Math.floor((keepFrom - this.originMs) * BYTES_PER_MS));
    if (skip > 0 && skip < this.pcm.length) {
      this.pcm = this.pcm.subarray(skip);
      this.originMs += skip / BYTES_PER_MS;
    }
  }
}
