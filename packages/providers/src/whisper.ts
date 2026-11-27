import { ProviderError, mapHttpError, toProviderError } from './errors';
import type { SttHandlers, SttOptions, SttSession, StreamingTranscriptionProvider } from './stt';
import type { FetchLike } from './types';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Utterances longer than this are transcribed in pieces. */
const MAX_UTTERANCE_SECONDS = 45;
/** Below this much voiced audio an utterance is noise, not speech: never sent. */
const MIN_VOICED_MS = 250;
const VOICED_DBFS = -45;

export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function chunkDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return -100;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return rms <= 1e-5 ? -100 : 20 * Math.log10(rms);
}

interface WhisperSegment {
  text?: string;
  start?: number | null;
  end?: number | null;
  no_speech_prob?: number;
  words?: Array<{ word?: string; start?: number | null; end?: number | null; probability?: number }>;
}

/** Drops segments Whisper itself marks as probably-not-speech (its classic silence hallucinations). */
export function whisperText(j: { text?: string; segments?: WhisperSegment[] }): string {
  if (Array.isArray(j.segments) && j.segments.length > 0) {
    return j.segments
      .filter((s) => (s.no_speech_prob ?? 0) < 0.6)
      .map((s) => (s.text ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return (j.text ?? '').trim();
}

/** Strips whisper.cpp's non-speech annotations: "[BLANK_AUDIO]", "(music)", "[ Silence ]". */
export function stripAnnotations(text: string): string {
  return text
    .replace(/\[[^\]]{1,40}\]|\((?:music|silence|applause|laughter|noise|inaudible|blank_audio)[^)]{0,20}\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where and how an utterance is transcribed. */
interface WhisperEndpoint {
  providerId: 'local-whisper';
  url: string;
  headers: Record<string, string>;
  /** Builds the multipart body for one WAV. */
  form(wav: Blob, opts: SttOptions): FormData;
  /**
   * Live text while the speaker talks: re-transcribe the utterance so far this often
   * (ms), and again as soon as they go quiet. null = final text only.
   */
  interimEveryMs: number | null;
  /** Extra silence after the VAD's end of speech before the final transcription. */
  endDebounceMs: number;
  timeoutMs: number;
}

/** whisper.cpp initial_prompt is truncated around this many tokens. */
export const WHISPER_PROMPT_MAX_TOKENS = 224;

export interface WhisperWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface WhisperParse {
  text: string;
  words: WhisperWord[];
  wordTimestamps: boolean;
}

/**
 * Merge token-level verbose_json "words" into display words (split_on_word / leading space).
 * whisper-server started with -nt (no timestamps) still lists words, but with null times: then
 * this reports wordTimestamps=false and falls back to segment text, so nothing is dropped.
 */
export function parseWhisperResponse(j: { text?: string; segments?: WhisperSegment[] }): WhisperParse {
  const text = stripAnnotations(whisperText(j));
  const timed = (x: { start?: number | null; end?: number | null }): boolean => typeof x.start === 'number' && typeof x.end === 'number';
  const kept = (j.segments ?? []).filter((seg) => (seg.no_speech_prob ?? 0) < 0.6);
  const wordTimestamps = kept.some((seg) => Array.isArray(seg.words) && seg.words.length > 0 && seg.words.every(timed));
  const words: WhisperWord[] = [];
  for (const seg of kept) {
    if (wordTimestamps && Array.isArray(seg.words) && seg.words.length) {
      for (const w of seg.words) {
        const raw = (w.word ?? '').replace(/\s+/g, ' ');
        if (!raw.trim()) continue;
        const startMs = Math.round((w.start ?? 0) * 1000);
        const endMs = Math.round((w.end ?? w.start ?? 0) * 1000);
        if (raw.startsWith(' ') || words.length === 0) words.push({ text: raw.trim(), startMs, endMs });
        else {
          const last = words[words.length - 1]!;
          last.text += raw.trim();
          last.endMs = endMs;
        }
      }
    } else if (seg.text?.trim() && timed(seg)) {
      words.push({
        text: stripAnnotations(seg.text.trim()),
        startMs: Math.round(seg.start! * 1000),
        endMs: Math.round(seg.end! * 1000),
      });
    }
  }
  return { text, words: words.filter((w) => w.text), wordTimestamps };
}

export async function runWhisperInference(
  url: string,
  fetchImpl: FetchLike,
  pcm: Buffer,
  opts: {
    language: string;
    prompt: string;
    timeoutMs?: number;
    beamSize?: number;
    wordTimestamps?: boolean;
  },
): Promise<WhisperParse> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'utterance.wav');
  form.append('temperature', '0.0');
  form.append('response_format', opts.wordTimestamps === false ? 'json' : 'verbose_json');
  if (opts.wordTimestamps !== false) {
    form.append('token_timestamps', 'true');
    form.append('split_on_word', 'true');
  }
  const lang = opts.language.split('-')[0]?.toLowerCase() ?? '';
  form.append('language', /^[a-z]{2}$/.test(lang) ? lang : 'auto');
  if (opts.prompt) form.append('prompt', opts.prompt.slice(0, WHISPER_PROMPT_MAX_TOKENS * 4));
  if (opts.beamSize && opts.beamSize > 1) form.append('beam_size', String(opts.beamSize));
  const res = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  const body = await res.text();
  if (!res.ok) throw mapHttpError('local-whisper', res.status, body);
  let j: { text?: string; segments?: WhisperSegment[] };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    throw new ProviderError('local-whisper', 'server_error', 'Transcription server returned non-JSON');
  }
  return parseWhisperResponse(j);
}

/** Default address of the whisper.cpp server Doing starts (loopback only). */
export const LOCAL_WHISPER_DEFAULT_URL = 'http://127.0.0.1:8178';

/**
 * whisper.cpp's HTTP server on this PC. The utterance in progress is re-transcribed
 * every ~350 ms on a GPU (less often on a CPU) and the moment the speaker goes quiet:
 * live text that lets answers start before the question is over.
 */
export class LocalWhisperTranscriber implements StreamingTranscriptionProvider {
  readonly id = 'local-whisper' as const;
  readonly label = 'Whisper on this PC';
  /** Finals take ~150 ms here, so end the utterance at the same 300 ms pause that reveals early answers. */
  readonly speechEndHangoverMs = 300;
  readonly maxSessionMs = null;
  readonly wantsEndOfSpeech = true;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    /** How often live text is refreshed while someone speaks (CPU transcription needs longer). */
    private readonly interimEveryMs = 350,
  ) {}

  async open(opts: SttOptions, h: SttHandlers, signal?: AbortSignal): Promise<SttSession> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/`, { method: 'GET', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(4000)]) });
      await res.text();
    } catch (err) {
      const pe = toProviderError('local-whisper', err);
      throw new ProviderError('local-whisper', 'network', `Speech recognition isn't running (${pe.message}). Doing starts it automatically once setup is complete.`);
    }
    const endpoint: WhisperEndpoint = {
      providerId: 'local-whisper',
      url: `${this.baseUrl}/inference`,
      headers: {},
      form: (wav, o) => {
        const form = new FormData();
        form.append('file', wav, 'utterance.wav');
        form.append('temperature', '0.0');
        form.append('response_format', 'json');
        const lang = o.language.split('-')[0]?.toLowerCase() ?? '';
        form.append('language', /^[a-z]{2}$/.test(lang) ? lang : 'auto');
        if (o.vocabulary.length) form.append('prompt', o.vocabulary.join(', ').slice(0, 400));
        return form;
      },
      interimEveryMs: this.interimEveryMs,
      endDebounceMs: 60,
      timeoutMs: 8000,
    };
    return new WhisperUtteranceSession(endpoint, this.fetchImpl, opts, h);
  }
}

/** Live text only needs the end of a long utterance (where the question usually is). */
const INTERIM_MAX_SECONDS = 15;
const MIN_INTERIM_VOICED_MS = 400;

class WhisperUtteranceSession implements SttSession {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private voicedMs = 0;
  private open = true;
  private queue: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inflight = new Set<AbortController>();
  /** Bumped at every final flush so a late interim for an earlier utterance is dropped. */
  private utterance = 0;
  private interimBusy = false;
  private lastInterimAt = 0;
  private interimBytes = 0;

  constructor(
    private readonly endpoint: WhisperEndpoint,
    private readonly fetchImpl: FetchLike,
    private readonly opts: SttOptions,
    private readonly h: SttHandlers,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  get bufferedBytes(): number {
    return 0;
  }

  sendAudio(pcm: Buffer): boolean {
    if (!this.open) return false;
    this.chunks.push(pcm);
    this.bytes += pcm.length;
    if (chunkDbfs(pcm) > VOICED_DBFS) {
      this.voicedMs += (pcm.length / BYTES_PER_SECOND) * 1000;
      // Speech resumed before the debounce ran out: it's the same utterance.
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      const every = this.endpoint.interimEveryMs;
      if (every !== null && Date.now() - this.lastInterimAt >= every) this.interim();
    }
    if (this.bytes >= MAX_UTTERANCE_SECONDS * BYTES_PER_SECOND) this.flush();
    return true;
  }

  /** Speaker went quiet: refresh the live text with everything said so far. */
  silenceStarted(): void {
    if (this.endpoint.interimEveryMs !== null && this.bytes > this.interimBytes) this.interim(true);
  }

  private interim(force = false): void {
    if (this.interimBusy || this.voicedMs < MIN_INTERIM_VOICED_MS) return;
    if (!force && this.bytes === this.interimBytes) return;
    const all = Buffer.concat(this.chunks);
    const max = INTERIM_MAX_SECONDS * BYTES_PER_SECOND;
    const audio = all.length > max ? all.subarray(all.length - max) : all;
    const utterance = this.utterance;
    this.interimBusy = true;
    this.lastInterimAt = Date.now();
    this.interimBytes = this.bytes;
    void this.request(audio)
      .then((text) => {
        if (text && utterance === this.utterance && this.open) this.h.onInterim(text);
      })
      .catch(() => undefined) // live text is best-effort; the final reports errors
      .finally(() => {
        this.interimBusy = false;
      });
  }

  endOfSpeech(): void {
    if (!this.open || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.endpoint.endDebounceMs);
  }

  private flush(): void {
    const audio = Buffer.concat(this.chunks);
    const voiced = this.voicedMs;
    this.chunks = [];
    this.bytes = 0;
    this.voicedMs = 0;
    this.interimBytes = 0;
    this.utterance++;
    if (voiced < MIN_VOICED_MS || audio.length < BYTES_PER_SECOND / 4) return;
    this.queue = this.queue.then(() => this.transcribe(audio));
  }

  private async request(pcm: Buffer): Promise<string> {
    const ctl = new AbortController();
    this.inflight.add(ctl);
    const pid = this.endpoint.providerId;
    try {
      const form = this.endpoint.form(new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), this.opts);
      let res: Response;
      try {
        res = await this.fetchImpl(this.endpoint.url, {
          method: 'POST',
          headers: this.endpoint.headers,
          body: form,
          signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(this.endpoint.timeoutMs)]),
        });
      } catch (err) {
        throw toProviderError(pid, err);
      }
      const text = await res.text();
      if (!res.ok) throw mapHttpError(pid, res.status, text);
      let j: { text?: string; segments?: WhisperSegment[] };
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        throw new ProviderError(pid, 'server_error', 'Transcription server returned non-JSON');
      }
      return stripAnnotations(whisperText(j));
    } finally {
      this.inflight.delete(ctl);
    }
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    try {
      const out = await this.request(pcm);
      if (out) {
        this.h.onFinalSegment(out);
        this.h.onUtteranceEnd();
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : toProviderError('local-whisper', err);
      if (pe.code !== 'aborted') this.h.onError(pe);
    }
  }

  close(): void {
    if (!this.open) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Transcribe the last thing said before the user pressed Stop, then report closed.
    this.flush();
    this.open = false;
    void this.queue.finally(() => this.h.onClose(true, 'closed'));
  }
}
