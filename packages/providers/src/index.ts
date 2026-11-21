import type { ProviderId, SttProviderId } from '@hirora/contracts';
import { HIRORA_CLOUD_DEFAULT_BASE_URL, OLLAMA_DEFAULT_BASE_URL } from '@hirora/contracts';
import { GeminiEmbeddingProvider, GeminiTextProvider } from './gemini';
import { DEEPSEEK_BASE_URL, OllamaProvider, OpenAICompatibleProvider, XAI_BASE_URL, validateCustomBaseUrl, validateLocalBaseUrl } from './openaiCompatible';
import { GeminiLiveTranscriber, XaiStreamingTranscriber } from './stt';
import { CloudWhisperTranscriber, LOCAL_WHISPER_DEFAULT_URL, LocalWhisperTranscriber } from './whisper';
import type { StreamingTranscriptionProvider } from './stt';
import type { FetchLike, TextModelProvider } from './types';
import { ProviderError } from './errors';

export * from './errors';
export * from './sse';
export * from './types';
export * from './gemini';
export * from './openaiCompatible';
export * from './stt';
export * from './http';
export * from './whisper';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  cloud: 'Hirora Cloud (free shared server)',
  gemini: 'Google Gemini',
  xai: 'xAI Grok',
  deepseek: 'DeepSeek',
  ollama: 'Ollama (local, no key)',
  custom: 'Custom (OpenAI-compatible)',
};

/**
 * Suggested fast defaults, verified against official model docs (Nov 2026). They
 * are only pre-selected when the live model list for the user's key contains them.
 */
export const SUGGESTED_FAST_MODELS: Record<Exclude<ProviderId, 'custom'>, string[]> = {
  // Groq open models behind the relay (checked live 2026-11-21).
  cloud: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'],
  xai: ['grok-4.20-0309-non-reasoning', 'grok-4.3', 'grok-4.7'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  // Small instruct models that fit an 8 GB GPU; only pre-selected if already pulled.
  ollama: ['qwen3.5:4b', 'gemma4:e4b', 'qwen3.5:2b', 'gemma3:4b', 'llama3.2:3b'],
};

export const PROVIDER_CONSOLES: Record<Exclude<ProviderId, 'custom'>, string> = {
  cloud: 'https://hirora-one.vercel.app',
  gemini: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  ollama: 'https://ollama.com/download',
};

export interface CreateProviderOptions {
  customBaseUrl?: string;
  customLabel?: string;
  ollamaBaseUrl?: string;
  cloudBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createTextProvider(id: ProviderId, apiKey: string, opts: CreateProviderOptions = {}): TextModelProvider {
  const f = opts.fetchImpl ?? fetch;
  switch (id) {
    case 'cloud': {
      const base = validateCustomBaseUrl(opts.cloudBaseUrl || HIRORA_CLOUD_DEFAULT_BASE_URL);
      if (!base) throw new ProviderError('cloud', 'not_configured', 'The Hirora Cloud address must be an https:// URL.');
      return new OpenAICompatibleProvider('cloud', PROVIDER_LABELS.cloud, base, apiKey, f);
    }
    case 'gemini':
      return new GeminiTextProvider(apiKey, f);
    case 'xai':
      return new OpenAICompatibleProvider('xai', PROVIDER_LABELS.xai, XAI_BASE_URL, apiKey, f);
    case 'deepseek':
      return new OpenAICompatibleProvider('deepseek', PROVIDER_LABELS.deepseek, DEEPSEEK_BASE_URL, apiKey, f);
    case 'ollama': {
      const base = validateLocalBaseUrl(opts.ollamaBaseUrl || OLLAMA_DEFAULT_BASE_URL);
      if (!base) throw new ProviderError('ollama', 'not_configured', 'The Ollama endpoint must be on this PC (http://127.0.0.1 or http://localhost).');
      // Ollama ignores the bearer token; a placeholder keeps the request shape OpenAI-compatible.
      return new OllamaProvider(base, f);
    }
    case 'custom': {
      const base = validateCustomBaseUrl(opts.customBaseUrl ?? '');
      if (!base) throw new ProviderError('custom', 'not_configured', 'Custom endpoint must be an https:// URL (http:// only for localhost).');
      return new OpenAICompatibleProvider('custom', opts.customLabel || PROVIDER_LABELS.custom, base, apiKey, f);
    }
  }
}

/** STT needs the key of the vendor that runs it. */
export const STT_KEY_PROVIDER: Record<SttProviderId, ProviderId> = {
  'cloud-whisper': 'cloud',
  'local-whisper': 'ollama', // keyless: runs on this PC
  'gemini-live': 'gemini',
  'xai-stt': 'xai',
};

export function createTranscriber(id: SttProviderId, apiKey: string, opts: { cloudBaseUrl?: string; localWhisperUrl?: string; fetchImpl?: FetchLike } = {}): StreamingTranscriptionProvider {
  switch (id) {
    case 'local-whisper': {
      const base = validateLocalBaseUrl(opts.localWhisperUrl || LOCAL_WHISPER_DEFAULT_URL);
      if (!base) throw new ProviderError('local-whisper', 'not_configured', 'Local Whisper must run on this PC (http://127.0.0.1 or http://localhost).');
      return new LocalWhisperTranscriber(base, opts.fetchImpl ?? fetch);
    }
    case 'cloud-whisper': {
      const base = validateCustomBaseUrl(opts.cloudBaseUrl || HIRORA_CLOUD_DEFAULT_BASE_URL);
      if (!base) throw new ProviderError('cloud', 'not_configured', 'The Hirora Cloud address must be an https:// URL.');
      return new CloudWhisperTranscriber(apiKey, base, opts.fetchImpl ?? fetch);
    }
    case 'gemini-live':
      return new GeminiLiveTranscriber(apiKey);
    case 'xai-stt':
      return new XaiStreamingTranscriber(apiKey);
  }
}

export function createEmbeddingProvider(apiKey: string, model: string, fetchImpl?: FetchLike) {
  return new GeminiEmbeddingProvider(apiKey, model, fetchImpl);
}
