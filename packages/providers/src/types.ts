import type { ModelInfo, ProviderId, Usage } from '@hirora/contracts';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/png' | 'image/jpeg'; base64: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface StreamRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  /** 'fast' asks the provider for minimal reasoning where the API supports it. */
  effort: 'fast' | 'deep';
  signal: AbortSignal;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning' }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: string | null };

export interface TextModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  stream(req: StreamRequest): AsyncGenerator<StreamChunk>;
  /** Warm TLS/HTTP2 connection so the first real request is faster. Best-effort. */
  /** Warm the connection; local runtimes also load `model` into memory. */
  preconnect(signal?: AbortSignal, model?: string): Promise<void>;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], kind: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}
