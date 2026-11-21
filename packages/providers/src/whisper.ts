import { ProviderError, mapHttpError, toProviderError } from './errors';
import { fetchJson } from './http';
import type { SttHandlers, SttOptions, SttSession, StreamingTranscriptionProvider } from './stt';
import type { FetchLike } from './types';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Utterances longer than this are sent in pieces (keeps requests well under the relay's 4 MB cap). */
const MAX_UTTERANCE_SECONDS = 45;
/** Extra silence after the local VAD says speech stopped, so a short pause doesn't split a sentence. */
const END_DEBOUNCE_MS = 350;
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

/**
 * Utterance-level transcription through Hirora Cloud (Groq Whisper behind the relay).
 * Audio is buffered while the local VAD hears speech and sent once the speaker
 * pauses, so there is no interim text: each utterance appears as final text
 * shortly after it ends.
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
    return new WhisperUtteranceSession(this.accessCode, this.baseUrl, this.fetchImpl, this.model, opts, h);
  }
}

class WhisperUtteranceSession implements SttSession {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private voicedMs = 0;
  private open = true;
  private queue: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inflight = new Set<AbortController>();

  constructor(
    private readonly accessCode: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly model: string,
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
    }
    if (this.bytes >= MAX_UTTERANCE_SECONDS * BYTES_PER_SECOND) this.flush();
    return true;
  }

  endOfSpeech(): void {
    if (!this.open || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, END_DEBOUNCE_MS);
  }

  private flush(): void {
    const audio = Buffer.concat(this.chunks);
    const voiced = this.voicedMs;
    this.chunks = [];
    this.bytes = 0;
    this.voicedMs = 0;
    if (voiced < MIN_VOICED_MS || audio.length < BYTES_PER_SECOND / 4) return;
    this.queue = this.queue.then(() => this.transcribe(audio));
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    const ctl = new AbortController();
    this.inflight.add(ctl);
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'utterance.wav');
      form.append('model', this.model);
      const lang = this.opts.language.split('-')[0]?.toLowerCase() ?? '';
      if (/^[a-z]{2}$/.test(lang)) form.append('language', lang);
      if (this.opts.vocabulary.length) form.append('prompt', this.opts.vocabulary.join(', ').slice(0, 400));
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.accessCode}` },
          body: form,
          signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(20_000)]),
        });
      } catch (err) {
        throw toProviderError('cloud', err);
      }
      const text = await res.text();
      if (!res.ok) throw mapHttpError('cloud', res.status, text);
      let j: { text?: string; segments?: WhisperSegment[] };
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        throw new ProviderError('cloud', 'server_error', 'Transcription server returned non-JSON');
      }
      const out = whisperText(j);
      if (out) {
        this.h.onFinalSegment(out);
        this.h.onUtteranceEnd();
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : toProviderError('cloud', err);
      if (pe.code !== 'aborted') this.h.onError(pe);
    } finally {
      this.inflight.delete(ctl);
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
