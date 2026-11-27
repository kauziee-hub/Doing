import type { ModelInfo, ProviderId } from '@hirora/contracts';
import { ProviderError, toProviderError } from './errors';
import { fetchJson, fetchStream } from './http';
import { readSse } from './sse';
import type { ChatMessage, FetchLike, StreamChunk, StreamRequest, TextModelProvider } from './types';

interface Flavor {
  /** Extra body fields for fast (low-latency) answers. */
  fastExtras?: (model: string) => Record<string, unknown>;
  /** Filter for model listing: return false to hide non-chat models. */
  isChatModel?: (id: string) => boolean;
  supportsStreamUsage: boolean;
  sendsTemperature: boolean;
}

/** Doing's answer engine: Ollama's OpenAI-compatible API on loopback. */
const OLLAMA_FLAVOR: Flavor = {
  // Ollama lists every pulled model, embeddings included.
  isChatModel: (id) => !/embed|bge|minilm|rerank/i.test(id),
  // Fast cues skip reasoning on thinking models (qwen3.5 thinks by default).
  fastExtras: () => ({ reasoning_effort: 'none' }),
  supportsStreamUsage: true,
  sendsTemperature: true,
};

interface ChatChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  error?: { message?: string };
}

/** OpenAI-compatible `/chat/completions` streaming, as served by the local Ollama runtime. */
export class OpenAICompatibleProvider implements TextModelProvider {
  private readonly flavor: Flavor;
  private readonly rejectedExtras = new Set<string>();

  constructor(
    readonly id: ProviderId,
    readonly label: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.flavor = OLLAMA_FLAVOR;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const data = await fetchJson<{ data?: Array<{ id: string; name?: string; context_window?: number; input_modalities?: string[] }> }>(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/models`,
      { method: 'GET', headers: this.headers(), signal },
    );
    return (data.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.name,
      contextWindow: m.context_window,
      supportsText: this.flavor.isChatModel ? this.flavor.isChatModel(m.id) : true,
      supportsImages: m.input_modalities ? m.input_modalities.includes('image') : undefined,
    }));
  }

  async preconnect(signal?: AbortSignal): Promise<void> {
    await this.listModels(signal);
  }

  static toOpenAIMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) =>
              p.type === 'text'
                ? { type: 'text', text: p.text }
                : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}` } },
            ),
    }));
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamChunk> {
    const build = (withExtras: boolean, withUsage: boolean) => {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: OpenAICompatibleProvider.toOpenAIMessages(req.messages),
        stream: true,
        max_tokens: req.maxOutputTokens,
      };
      if (this.flavor.sendsTemperature && req.temperature !== undefined) body.temperature = req.temperature;
      if (withUsage) body.stream_options = { include_usage: true };
      if (withExtras && req.effort === 'fast' && this.flavor.fastExtras) Object.assign(body, this.flavor.fastExtras(req.model));
      return body;
    };
    const extrasKey = `${req.model}`;
    let withExtras = !this.rejectedExtras.has(extrasKey);
    let body: ReadableStream<Uint8Array> | null = null;
    for (let attempt = 0; !body; attempt++) {
      try {
        body = await fetchStream(this.id, this.fetchImpl, `${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(build(withExtras, this.flavor.supportsStreamUsage)),
          signal: req.signal,
        });
        // Only a request that worked without the fields proves the model rejects them.
        if (attempt > 0 && !withExtras) this.rejectedExtras.add(extrasKey);
      } catch (err) {
        const pe = toProviderError(this.id, err);
        // Some models reject optional fields (e.g. thinking toggles): retry once without them.
        // Not for an over-long prompt: that 400 says nothing about the fields, and dropping
        // `reasoning_effort` for good made qwen3.5 think on every later answer, which then came
        // back slow or empty (measured on 0.3.4, 2026-11-26).
        if ((pe.status === 400 || pe.status === 422) && !isContextOverflowMessage(pe.message) && withExtras && this.flavor.fastExtras && req.effort === 'fast' && attempt === 0) {
          withExtras = false;
          continue;
        }
        throw pe;
      }
    }

    let finishReason: string | null = null;
    try {
      for await (const ev of readSse(body, req.signal)) {
        if (!ev.data) continue;
        if (ev.data.trim() === '[DONE]') break;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(ev.data) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError(this.id, 'server_error', chunk.error.message ?? 'Stream error');
        const choice = chunk.choices?.[0];
        if (choice?.delta?.reasoning_content) yield { type: 'reasoning' };
        if (choice?.delta?.content) yield { type: 'text', text: choice.delta.content };
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
              reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
            },
          };
        }
      }
    } catch (err) {
      throw toProviderError(this.id, err);
    }
    if (finishReason === 'content_filter') {
      throw new ProviderError(this.id, 'content_filtered', 'Response stopped by provider content filter');
    }
    yield { type: 'done', finishReason };
  }
}

/** Ollama / llama.cpp wording for a prompt that does not fit the context. */
export function isContextOverflowMessage(message: string): boolean {
  return /context length|prompt is longer|exceeds? (the )?(available )?context|context (size|window)/i.test(message);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The engine must stay on this PC: loopback http(s) only, no credentials. */
export function validateLocalBaseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname) && !u.username && !u.password) {
      return u.toString().replace(/\/+$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ollama running on this PC: OpenAI-compatible streaming chat, plus Ollama's native
 * /api/generate to load a model into memory ahead of the first question.
 */
export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly nativeBase: string;

  constructor(
    baseUrl: string,
    private readonly localFetch: FetchLike = fetch,
  ) {
    // Ollama ignores the bearer token; a placeholder keeps the request OpenAI-shaped.
    super('ollama', 'On this PC', baseUrl, 'ollama', localFetch);
    this.nativeBase = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  /** With a model: load it and keep it resident for 30 min, so the first answer skips the cold load. */
  override async preconnect(signal?: AbortSignal, model?: string): Promise<void> {
    if (!model) return super.preconnect(signal);
    await fetchJson('ollama', this.localFetch, `${this.nativeBase}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '30m', stream: false }),
      signal,
      timeoutMs: 120_000,
    });
  }
}
