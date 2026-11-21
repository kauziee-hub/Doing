import WebSocket from 'ws';
import type { SttProviderId } from '@hirora/contracts';
import { ProviderError, mapHttpError, sanitizeProviderMessage } from './errors';

export interface SttOptions {
  /** BCP-47 language (e.g. en-US). Empty = automatic detection. */
  language: string;
  vocabulary: string[];
  geminiMode: 'VERBATIM' | 'SMART';
  endpointingMs: number;
}

export interface SttHandlers {
  /** Speculative text for the utterance in progress (replaces the previous interim). */
  onInterim(text: string): void;
  /** Stable text to append to the utterance in progress. */
  onFinalSegment(text: string): void;
  /** The provider believes the speaker finished this utterance. */
  onUtteranceEnd(): void;
  onError(err: ProviderError): void;
  /** Connection closed. `expected` is true when we closed it ourselves. */
  onClose(expected: boolean, reason: string): void;
  /** Provider asked us to reconnect soon (e.g. Gemini goAway). */
  onGoAway?(): void;
}

export interface SttSession {
  sendAudio(pcm16le: Buffer): boolean;
  endOfSpeech(): void;
  /** The speaker just went quiet (may resume). Utterance transcribers refresh their live text now. */
  silenceStarted?(): void;
  close(): void;
  readonly isOpen: boolean;
  readonly bufferedBytes: number;
}

export interface StreamingTranscriptionProvider {
  readonly id: SttProviderId;
  readonly label: string;
  /** Provider-enforced maximum continuous session length, or null. */
  readonly maxSessionMs: number | null;
  /** Wants endOfSpeech() when local VAD hears speech stop (Gemini hybrid VAD, Whisper utterances). */
  readonly wantsEndOfSpeech?: boolean;
  /** Silence that ends an utterance for the local VAD (default 450 ms). Fast local finals use less. */
  readonly speechEndHangoverMs?: number;
  open(opts: SttOptions, handlers: SttHandlers, signal?: AbortSignal): Promise<SttSession>;
}

/** Drop audio when the socket buffer exceeds ~2 s of 16 kHz PCM (backpressure). */
const MAX_BUFFERED_BYTES = 64_000;
const OPEN_TIMEOUT_MS = 10_000;

function wsCloseToError(provider: string, code: number, reason: string): ProviderError {
  const r = sanitizeProviderMessage(reason || `WebSocket closed (${code})`);
  const lower = r.toLowerCase();
  if (/api key|api_key|unauthenticated|unauthori[sz]ed|invalid.*key|permission/.test(lower)) return new ProviderError(provider, 'invalid_key', r);
  if (/quota|resource_exhausted|exhausted|billing|credit/.test(lower)) return new ProviderError(provider, 'quota_exceeded', r);
  if (/rate/.test(lower)) return new ProviderError(provider, 'rate_limited', r);
  if (/not found|not supported|model/.test(lower) && code === 1008) return new ProviderError(provider, 'model_not_found', r);
  if (code === 1011 || code === 1013) return new ProviderError(provider, 'server_error', r);
  if (code === 1006) return new ProviderError(provider, 'network', r || 'Connection lost');
  return new ProviderError(provider, 'unknown', r);
}

function attachHandshakeErrors(ws: WebSocket, provider: string, reject: (e: ProviderError) => void): void {
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c: Buffer) => {
      if (body.length < 4000) body += c.toString('utf8');
    });
    res.on('end', () => reject(mapHttpError(provider, res.statusCode ?? 0, body)));
  });
}

// ─────────────────────────── Gemini 3.5 Transcribe Live ───────────────────────────

export const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';

interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    interimInputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
  goAway?: { timeLeft?: string };
  error?: { message?: string; code?: number };
}

export class GeminiLiveTranscriber implements StreamingTranscriptionProvider {
  readonly id = 'gemini-live' as const;
  readonly wantsEndOfSpeech = true;
  readonly label = 'Gemini 3.5 Transcribe Live';
  /** Documented maximum continuous streaming duration is 10 minutes. */
  readonly maxSessionMs = 10 * 60 * 1000;

  constructor(
    private readonly apiKey: string,
    private readonly url = GEMINI_LIVE_URL,
    private readonly model = GEMINI_TRANSCRIBE_MODEL,
  ) {}

  open(opts: SttOptions, h: SttHandlers, signal?: AbortSignal): Promise<SttSession> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let closingByUs = false;
      let smartCumulative = '';
      const ws = new WebSocket(`${this.url}?key=${encodeURIComponent(this.apiKey)}`, { handshakeTimeout: OPEN_TIMEOUT_MS });
      const fail = (e: ProviderError) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        } else {
          h.onError(e);
        }
      };
      const timer = setTimeout(() => fail(new ProviderError('gemini', 'timeout', 'Transcription session did not open in time')), OPEN_TIMEOUT_MS);
      signal?.addEventListener('abort', () => fail(new ProviderError('gemini', 'aborted', 'Cancelled')), { once: true });
      attachHandshakeErrors(ws, 'gemini', fail);

      const session: SttSession = {
        sendAudio(pcm) {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) return false;
          ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
          return true;
        },
        endOfSpeech() {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        },
        close() {
          closingByUs = true;
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
            ws.close(1000, 'client closing');
          } catch {
            /* ignore */
          }
          setTimeout(() => ws.terminate(), 1500).unref?.();
        },
        get isOpen() {
          return ws.readyState === WebSocket.OPEN;
        },
        get bufferedBytes() {
          return ws.bufferedAmount;
        },
      };

      ws.on('open', () => {
        const transcription: Record<string, unknown> = { mode: opts.geminiMode };
        if (opts.language) transcription.languageCodes = [opts.language];
        if (opts.vocabulary.length) transcription.customVocabulary = opts.vocabulary.slice(0, 1000);
        ws.send(
          JSON.stringify({
            setup: {
              model: `models/${this.model}`,
              generationConfig: { responseModalities: ['TEXT'] },
              inputAudioTranscription: transcription,
            },
          }),
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: GeminiServerMessage;
        try {
          msg = JSON.parse(raw.toString()) as GeminiServerMessage;
        } catch {
          return;
        }
        if (msg.error) {
          fail(mapHttpError('gemini', msg.error.code ?? 500, JSON.stringify({ error: msg.error })));
          return;
        }
        if (msg.setupComplete !== undefined && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(session);
          return;
        }
        const sc = msg.serverContent;
        if (sc) {
          if (sc.interimInputTranscription) h.onInterim(sc.interimInputTranscription.text ?? '');
          if (sc.inputTranscription) {
            const text = sc.inputTranscription.text ?? '';
            if (opts.geminiMode === 'SMART') {
              // SMART mode finals are cumulative for the session: emit only the new suffix.
              const delta = text.startsWith(smartCumulative) ? text.slice(smartCumulative.length) : text;
              smartCumulative = text;
              if (delta.trim()) h.onFinalSegment(delta);
            } else if (text.trim()) {
              h.onFinalSegment(text);
            }
          }
          if (sc.turnComplete || sc.generationComplete) h.onUtteranceEnd();
        }
        if (msg.goAway) h.onGoAway?.();
      });

      ws.on('error', (err) => fail(new ProviderError('gemini', 'network', sanitizeProviderMessage(err.message))));
      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf.toString();
        if (!settled) {
          fail(wsCloseToError('gemini', code, reason));
          return;
        }
        if (!closingByUs && code !== 1000) h.onError(wsCloseToError('gemini', code, reason));
        h.onClose(closingByUs, reason);
      });
    });
  }
}

// ─────────────────────────── xAI streaming STT ───────────────────────────

export const XAI_STT_URL = 'wss://api.x.ai/v1/stt';
export const XAI_STT_MODEL = 'grok-voice-transcribe-2.0';

interface XaiEvent {
  type: string;
  text?: string;
  is_final?: boolean;
  speech_final?: boolean;
  message?: string;
}

export class XaiStreamingTranscriber implements StreamingTranscriptionProvider {
  readonly id = 'xai-stt' as const;
  readonly label = 'xAI Grok streaming STT';
  readonly maxSessionMs = null;

  constructor(
    private readonly apiKey: string,
    private readonly url = XAI_STT_URL,
    private readonly model = XAI_STT_MODEL,
  ) {}

  static buildUrl(base: string, model: string, opts: SttOptions): string {
    const q = new URLSearchParams({
      model,
      encoding: 'pcm',
      sample_rate: '16000',
      interim_results: 'true',
      endpointing: String(Math.max(0, Math.min(5000, opts.endpointingMs))),
    });
    if (opts.language) q.set('language', opts.language.split('-')[0]!.toLowerCase());
    for (const term of opts.vocabulary.slice(0, 100)) q.append('keyterm', term.slice(0, 50));
    return `${base}?${q.toString()}`;
  }

  open(opts: SttOptions, h: SttHandlers, signal?: AbortSignal): Promise<SttSession> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let closingByUs = false;
      const ws = new WebSocket(XaiStreamingTranscriber.buildUrl(this.url, this.model, opts), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        handshakeTimeout: OPEN_TIMEOUT_MS,
      });
      const fail = (e: ProviderError) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        } else {
          h.onError(e);
        }
      };
      const timer = setTimeout(() => fail(new ProviderError('xai', 'timeout', 'Transcription session did not open in time')), OPEN_TIMEOUT_MS);
      signal?.addEventListener('abort', () => fail(new ProviderError('xai', 'aborted', 'Cancelled')), { once: true });
      attachHandshakeErrors(ws, 'xai', fail);

      const session: SttSession = {
        sendAudio(pcm) {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) return false;
          ws.send(pcm, { binary: true });
          return true;
        },
        endOfSpeech() {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finalize' }));
        },
        close() {
          closingByUs = true;
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio.done' }));
          } catch {
            /* ignore */
          }
          setTimeout(() => ws.terminate(), 1500).unref?.();
        },
        get isOpen() {
          return ws.readyState === WebSocket.OPEN;
        },
        get bufferedBytes() {
          return ws.bufferedAmount;
        },
      };

      ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let ev: XaiEvent;
        try {
          ev = JSON.parse(raw.toString()) as XaiEvent;
        } catch {
          return;
        }
        switch (ev.type) {
          case 'transcript.created':
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(session);
            }
            break;
          case 'transcript.partial': {
            const text = ev.text ?? '';
            if (!ev.is_final) {
              h.onInterim(text);
            } else {
              if (text.trim()) h.onFinalSegment(text);
              h.onInterim('');
              if (ev.speech_final) h.onUtteranceEnd();
            }
            break;
          }
          case 'transcript.done':
            h.onUtteranceEnd();
            try {
              ws.close(1000);
            } catch {
              /* ignore */
            }
            break;
          case 'error':
            fail(wsCloseToError('xai', 1011, ev.message ?? 'Transcription error'));
            break;
          default:
            break;
        }
      });

      ws.on('error', (err) => fail(new ProviderError('xai', 'network', sanitizeProviderMessage(err.message))));
      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf.toString();
        if (!settled) {
          fail(wsCloseToError('xai', code, reason));
          return;
        }
        if (!closingByUs && code !== 1000) h.onError(wsCloseToError('xai', code, reason));
        h.onClose(closingByUs, reason);
      });
    });
  }
}
