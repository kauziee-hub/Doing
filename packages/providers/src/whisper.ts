import { ProviderError, mapHttpError, toProviderError } from './errors';
import { fetchJson } from './http';
import type { SttHandlers, SttOptions, SttSession, StreamingTranscriptionProvider } from './stt';
import type { FetchLike } from './types';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Utterances longer than this are sent in pieces (keeps requests well under the relay's 4 MB cap). */
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
  no_speech_prob?: number;
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
  providerId: 'cloud' | 'local-whisper';
  url: string;
  headers: Record<string, string>;
  /** Builds the multipart body for one WAV. */
  form(wav: Blob, opts: SttOptions): FormData;
  /**
   * Live text while the speaker talks: re-transcribe the utterance so far this often
   * (ms), and again as soon as they go quiet. null = final text only (rate-limited cloud).
   */
  interimEveryMs: number | null;
  /** Extra silence after the VAD's end of speech before the final transcription. */
  endDebounceMs: number;
  timeoutMs: number;
}

/**
 * Utterance-level transcription through Hirora Cloud (Groq Whisper behind the relay).
 * Audio is buffered while the local VAD hears speech and sent once the speaker
 * pauses, so there is no interim text: each utterance appears as final text
 * shortly after it ends (the free tier allows ~20 transcriptions a minute).
 */
export class CloudWhisperTranscriber implements StreamingTranscriptionProvider {
  readonly id = 'cloud-whisper' as const;
  readonly label = 'Hirora Cloud (Whisper)';
  readonly maxSessionMs = null;
  readonly wantsEndOfSpeech = true;

  constructor(
    private readonly accessCode: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly model = 'whisper-large-v3-turbo',
  ) {}

  async open(opts: SttOptions, h: SttHandlers, signal?: AbortSignal): Promise<SttSession> {
    // Fail like a bad key (and stop retrying) when the code is wrong or the server is down.
    await fetchJson('cloud', this.fetchImpl, `${this.baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.accessCode}` },
      signal,
      timeoutMs: 10_000,
    });
    const model = this.model;
    const endpoint: WhisperEndpoint = {
      providerId: 'cloud',
      url: `${this.baseUrl}/audio/transcriptions`,
      headers: { authorization: `Bearer ${this.accessCode}` },
      form: (wav, o) => {
        const form = new FormData();
        form.append('file', wav, 'utterance.wav');
        form.append('model', model);
        const lang = o.language.split('-')[0]?.toLowerCase() ?? '';
        if (/^[a-z]{2}$/.test(lang)) form.append('language', lang);
        if (o.vocabulary.length) form.append('prompt', o.vocabulary.join(', ').slice(0, 400));
        return form;
      },
      interimEveryMs: null,
      endDebounceMs: 350,
      timeoutMs: 20_000,
    };
    return new WhisperUtteranceSession(endpoint, this.fetchImpl, opts, h);
  }
}

/** Default address of the bundled-on-demand whisper.cpp server (loopback only). */
export const LOCAL_WHISPER_DEFAULT_URL = 'http://127.0.0.1:8178';

/**
 * whisper.cpp's HTTP server on this PC (GPU). No rate limits, so the utterance in
 * progress is re-transcribed every ~350 ms and the moment the speaker goes quiet:
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
  ) {}

  async open(opts: SttOptions, h: SttHandlers, signal?: AbortSignal): Promise<SttSession> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/`, { method: 'GET', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(4000)]) });
      await res.text();
    } catch (err) {
      const pe = toProviderError('local-whisper', err);
      throw new ProviderError('local-whisper', 'network', `Local Whisper isn't running on ${this.baseUrl} (${pe.message}). Hirora starts it automatically when its files are installed.`);
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
      interimEveryMs: 350,
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
    const pid = this.endpoint.providerId === 'cloud' ? 'cloud' : 'local-whisper';
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
      const pe = err instanceof ProviderError ? err : toProviderError(this.endpoint.providerId === 'cloud' ? 'cloud' : 'local-whisper', err);
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
