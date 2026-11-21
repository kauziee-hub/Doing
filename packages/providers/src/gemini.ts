import type { ModelInfo } from '@hirora/contracts';
import { ProviderError, mapHttpError, toProviderError } from './errors';
import { anySignal, fetchJson, fetchStream } from './http';
import { readSse } from './sse';
import type { ChatMessage, EmbeddingProvider, FetchLike, StreamChunk, StreamRequest, TextModelProvider } from './types';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Models that are not general text chat (image/music generation, agents, robotics, audio). */
const NON_CHAT_GEMINI = /embedding|tts|image|banana|lyria|veo|imagen|robotics|computer-use|deep-research|antigravity|customtools|live|transcribe|translate|aqa/i;

interface GeminiModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

/**
 * Fast-mode thinking levels to try in order. Gemini 3.x models accept different
 * level sets (e.g. some reject `minimal`), so the adapter falls back on a 400 that
 * mentions thinking and remembers what worked per model. `null` = omit the field.
 */
const FAST_THINKING_CHAIN: Array<string | null> = ['minimal', 'low', null];

export class GeminiTextProvider implements TextModelProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  private readonly thinkingIndex = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = GEMINI_API_BASE,
  ) {}

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = `${this.base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const data = await fetchJson<{ models?: GeminiModel[]; nextPageToken?: string }>('gemini', this.fetchImpl, url, {
        method: 'GET',
        headers: this.headers(),
        signal,
      });
      for (const m of data.models ?? []) {
        const id = m.name.replace(/^models\//, '');
        const methods = m.supportedGenerationMethods ?? [];
        out.push({
          id,
          displayName: m.displayName,
          contextWindow: m.inputTokenLimit,
          supportsText: methods.includes('generateContent') && !NON_CHAT_GEMINI.test(id),
          supportsImages: methods.includes('generateContent'),
        });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return out;
  }

  async preconnect(signal?: AbortSignal): Promise<void> {
    // A tiny authenticated GET warms DNS/TLS/HTTP2 for the streaming call.
    await fetchJson('gemini', this.fetchImpl, `${this.base}/models?pageSize=1`, {
      method: 'GET',
      headers: this.headers(),
      signal,
      timeoutMs: 8000,
    });
  }

  static toContents(messages: ChatMessage[]): { system: string; contents: unknown[] } {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')))
      .join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : m.content.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.base64 } })),
      }));
    return { system, contents };
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamChunk> {
    const { system, contents } = GeminiTextProvider.toContents(req.messages);
    const chain = req.effort === 'fast' ? FAST_THINKING_CHAIN : [null];
    let idx = req.effort === 'fast' ? (this.thinkingIndex.get(req.model) ?? 0) : 0;
    let body: ReadableStream<Uint8Array> | null = null;
    while (!body) {
      const level = chain[idx] ?? null;
      const generationConfig: Record<string, unknown> = {
        // Thinking tokens count toward the output budget on thinking models: leave headroom.
        maxOutputTokens: req.maxOutputTokens + (level === null && req.effort === 'deep' ? 4096 : 1024),
      };
      if (level) generationConfig.thinkingConfig = { thinkingLevel: level };
      const payload = {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig,
      };
      try {
        body = await fetchStream('gemini', this.fetchImpl, `${this.base}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: req.signal,
        });
        if (req.effort === 'fast') this.thinkingIndex.set(req.model, idx);
      } catch (err) {
        const pe = toProviderError('gemini', err);
        // Any 400 that names the thinking parameter means "unsupported level", not a bad model.
        const thinkingRejected = pe.status === 400 && /think/i.test(pe.message);
        if (thinkingRejected && idx < chain.length - 1) {
          idx++;
          continue;
        }
        throw pe;
      }
    }

    let finishReason: string | null = null;
    try {
      for await (const ev of readSse(body, req.signal)) {
        if (!ev.data || ev.data === '[DONE]') continue;
        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(ev.data) as GeminiChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw mapHttpError('gemini', chunk.error.code ?? 500, JSON.stringify({ error: chunk.error }));
        if (chunk.promptFeedback?.blockReason) {
          throw new ProviderError('gemini', 'content_filtered', `Blocked by provider: ${chunk.promptFeedback.blockReason}`);
        }
        const cand = chunk.candidates?.[0];
        for (const part of cand?.content?.parts ?? []) {
          if (part.thought) {
            yield { type: 'reasoning' };
          } else if (part.text) {
            yield { type: 'text', text: part.text };
          }
        }
        if (cand?.finishReason) finishReason = cand.finishReason;
        if (chunk.usageMetadata) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usageMetadata.promptTokenCount,
              outputTokens: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
              cachedInputTokens: chunk.usageMetadata.cachedContentTokenCount,
              reasoningTokens: chunk.usageMetadata.thoughtsTokenCount,
            },
          };
        }
      }
    } catch (err) {
      throw toProviderError('gemini', err);
    }
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'BLOCKLIST') {
      throw new ProviderError('gemini', 'content_filtered', `Response stopped by provider safety filter (${finishReason})`);
    }
    yield { type: 'done', finishReason };
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini';
  readonly dimensions = 768;

  constructor(
    private readonly apiKey: string,
    readonly model = 'gemini-embedding-001',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = GEMINI_API_BASE,
  ) {}

  async embed(texts: string[], kind: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const isV2 = /embedding-2/.test(this.model);
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const requests = batch.map((text) => {
        const t = text.slice(0, 7000);
        return isV2
          ? {
              model: `models/${this.model}`,
              content: { parts: [{ text: kind === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}` }] },
              output_dimensionality: this.dimensions,
            }
          : {
              model: `models/${this.model}`,
              content: { parts: [{ text: t }] },
              taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              outputDimensionality: this.dimensions,
            };
      });
      const data = await fetchJson<{ embeddings?: Array<{ values: number[] }> }>(
        'gemini',
        this.fetchImpl,
        `${this.base}/models/${encodeURIComponent(this.model)}:batchEmbedContents`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ requests }),
          signal: anySignal([signal]),
          timeoutMs: 30_000,
        },
      );
      const embs = data.embeddings ?? [];
      if (embs.length !== batch.length) throw new ProviderError('gemini', 'server_error', 'Embedding count mismatch');
      for (const e of embs) out.push(normalize(Float32Array.from(e.values)));
    }
    return out;
  }
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}
