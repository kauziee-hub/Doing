import { ENGINE_OLLAMA_URL, ENGINE_WHISPER_URL } from '@hirora/contracts';
import { OllamaProvider, validateLocalBaseUrl } from './openaiCompatible';
import { LocalWhisperTranscriber } from './whisper';
import type { StreamingTranscriptionProvider } from './stt';
import type { FetchLike, TextModelProvider } from './types';
import { ProviderError } from './errors';

export * from './errors';
export * from './sse';
export * from './types';
export * from './openaiCompatible';
export * from './stt';
export * from './http';
export * from './whisper';

/** The answer engine: Hirora's own Ollama runtime on loopback (ADR 0012). */
export function createAnswerProvider(opts: { baseUrl?: string; fetchImpl?: FetchLike } = {}): TextModelProvider {
  const base = validateLocalBaseUrl(opts.baseUrl ?? ENGINE_OLLAMA_URL);
  if (!base) throw new ProviderError('ollama', 'not_configured', 'The answer engine must run on this PC (http://127.0.0.1).');
  return new OllamaProvider(base, opts.fetchImpl ?? fetch);
}

/** Live transcription: Hirora's whisper.cpp server on loopback. */
export function createTranscriber(opts: { url?: string; interimEveryMs?: number; fetchImpl?: FetchLike } = {}): StreamingTranscriptionProvider {
  const base = validateLocalBaseUrl(opts.url ?? ENGINE_WHISPER_URL);
  if (!base) throw new ProviderError('local-whisper', 'not_configured', 'Speech recognition must run on this PC (http://127.0.0.1).');
  return new LocalWhisperTranscriber(base, opts.fetchImpl ?? fetch, opts.interimEveryMs);
}
