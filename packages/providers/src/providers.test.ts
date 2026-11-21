/**
 * FIXTURE TESTS: local HTTP/WebSocket servers that speak the documented wire
 * formats (Gemini streamGenerateContent SSE, OpenAI-compatible chat SSE,
 * Gemini Live transcription, xAI streaming STT). They verify our parsing,
 * error mapping and fallbacks — they are NOT evidence that a real provider
 * works with a real key. Fixtures are never used by the app at runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { SseParser } from './sse';
import { mapHttpError } from './errors';
import { GeminiTextProvider } from './gemini';
import { OllamaProvider, OpenAICompatibleProvider, validateCustomBaseUrl, validateLocalBaseUrl } from './openaiCompatible';
import { GeminiLiveTranscriber, XaiStreamingTranscriber } from './stt';
import type { StreamChunk } from './types';

describe('SseParser', () => {
  it('handles split chunks, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    const out = [
      ...p.push('data: {"a"'),
      ...p.push(':1}\r\n\r\n: keepalive\n\nevent: x\ndata: line1\ndata: line2\n'),
      ...p.push('\n'),
    ];
    expect(out).toEqual([
      { event: null, data: '{"a":1}' },
      { event: 'x', data: 'line1\nline2' },
    ]);
  });
});

describe('mapHttpError', () => {
  it('classifies provider errors without leaking keys', () => {
    expect(mapHttpError('x', 401, '{"error":{"message":"bad"}}').code).toBe('invalid_key');
    expect(mapHttpError('x', 400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}').code).toBe('invalid_key');
    expect(mapHttpError('x', 429, '{"error":{"message":"You exceeded your current quota"}}').code).toBe('quota_exceeded');
    expect(mapHttpError('x', 429, 'slow down').code).toBe('rate_limited');
    expect(mapHttpError('x', 402, 'Insufficient Balance').code).toBe('quota_exceeded');
    expect(mapHttpError('x', 404, 'model not found').code).toBe('model_not_found');
    expect(mapHttpError('x', 503, 'overloaded').retryable).toBe(true);
    const leaked = mapHttpError('x', 400, 'bad request for key=AIza' + 'B'.repeat(35));
    expect(leaked.message).not.toMatch(/AIza/);
  });

  it('validates custom endpoints', () => {
    expect(validateCustomBaseUrl('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1');
    expect(validateCustomBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(validateCustomBaseUrl('http://evil.example.com/v1')).toBeNull();
    expect(validateCustomBaseUrl('https://user:pw@gw.example.com')).toBeNull();
  });
});

// ─── HTTP fixture server ───
let server: Server;
let base = '';
type Route = (req: IncomingMessage, body: string, res: ServerResponse) => void;
const routes = new Map<string, Route>();
const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      const key = [...routes.keys()].find((k) => (req.url ?? '').startsWith(k));
      if (!key) {
        res.writeHead(404).end('{"error":{"message":"no route"}}');
        return;
      }
      routes.get(key)!(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<{ text: string; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return { text: chunks.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join(''), chunks };
}

const sse = (res: ServerResponse, events: string[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${e}\n\n`);
  res.end();
};

describe('GeminiTextProvider (fixture)', () => {
  it('streams text, skips thought parts, reports usage and uses the header key', async () => {
    routes.clear();
    routes.set('/v1beta/models/m-ok:streamGenerateContent', (_req, _b, res) =>
      sse(res, [
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }),
        JSON.stringify({ candidates: [{ content: { parts: [{ text: ' world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 5 } }),
      ]),
    );
    const p = new GeminiTextProvider('test-key-123', fetch, `${base}/v1beta`);
    const r = await collect(p.stream({ model: 'm-ok', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], maxOutputTokens: 100, effort: 'fast', signal: new AbortController().signal }));
    expect(r.text).toBe('Hello world');
    expect(r.chunks.find((c) => c.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: undefined, reasoningTokens: 5 } });
    const req = seen[seen.length - 1]!;
    expect(req.headers['x-goog-api-key']).toBe('test-key-123');
    expect(req.url).not.toContain('test-key-123');
    const body = JSON.parse(req.body);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('falls back through thinking levels when the model rejects one, and remembers it', async () => {
    routes.clear();
    let calls = 0;
    routes.set('/v1beta/models/m-think:streamGenerateContent', (_req, body, res) => {
      calls++;
      const level = JSON.parse(body).generationConfig.thinkingConfig?.thinkingLevel;
      if (level === 'minimal') {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'thinking_level minimal is not supported for this model' } }));
        return;
      }
      sse(res, [JSON.stringify({ candidates: [{ content: { parts: [{ text: `ok:${level}` }] }, finishReason: 'STOP' }] })]);
    });
    const p = new GeminiTextProvider('k', fetch, `${base}/v1beta`);
    const req = () => p.stream({ model: 'm-think', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 50, effort: 'fast', signal: new AbortController().signal });
    expect((await collect(req())).text).toBe('ok:low');
    expect(calls).toBe(2);
    expect((await collect(req())).text).toBe('ok:low');
    expect(calls).toBe(3);
  });

  it('maps safety blocks and invalid keys to structured errors', async () => {
    routes.clear();
    routes.set('/v1beta/models/m-block', (_r, _b, res) => sse(res, [JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })]));
    routes.set('/v1beta/models/m-key', (_r, _b, res) => res.writeHead(400).end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } })));
    const p = new GeminiTextProvider('k', fetch, `${base}/v1beta`);
    const run = (model: string) => collect(p.stream({ model, messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'deep', signal: new AbortController().signal }));
    await expect(run('m-block')).rejects.toMatchObject({ code: 'content_filtered' });
    await expect(run('m-key')).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('lists models with pagination and filters non-text models', async () => {
    routes.clear();
    routes.set('/v1beta/models?pageSize=1000', (req, _b, res) => {
      const page2 = (req.url ?? '').includes('pageToken');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify(
          page2
            ? { models: [{ name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] }] }
            : { models: [{ name: 'models/fast-model', displayName: 'Fast', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 't2' },
        ),
      );
    });
    const models = await new GeminiTextProvider('k', fetch, `${base}/v1beta`).listModels();
    expect(models.map((m) => [m.id, m.supportsText])).toEqual([['fast-model', true], ['gemini-embedding-001', false]]);
  });
});

describe('OpenAICompatibleProvider (fixture)', () => {
  it('streams deltas, ignores reasoning_content text, stops at [DONE], sends bearer auth and DeepSeek fast extras', async () => {
    routes.clear();
    routes.set('/chat/completions', (_r, _b, res) =>
      sse(res, [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Foo' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Bar' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
        '[DONE]',
        JSON.stringify({ choices: [{ delta: { content: 'AFTER-DONE' } }] }),
      ]),
    );
    const p = new OpenAICompatibleProvider('deepseek', 'DeepSeek', base, 'sk-test', fetch);
    const r = await collect(p.stream({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 20, temperature: 0.2, effort: 'fast', signal: new AbortController().signal }));
    expect(r.text).toBe('FooBar');
    expect(r.chunks.some((c) => c.type === 'reasoning')).toBe(true);
    const req = seen[seen.length - 1]!;
    expect(req.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, thinking: { type: 'disabled' }, max_tokens: 20 });
  });

  it('retries once without optional extras when the model rejects them', async () => {
    routes.clear();
    let n = 0;
    routes.set('/chat/completions', (_r, body, res) => {
      n++;
      if (JSON.parse(body).thinking) {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'unknown field thinking' } }));
        return;
      }
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    const p = new OpenAICompatibleProvider('deepseek', 'DeepSeek', base, 'k', fetch);
    const r = await collect(p.stream({ model: 'x', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'fast', signal: new AbortController().signal }));
    expect(r.text).toBe('ok');
    expect(n).toBe(2);
  });

  it('aborts promptly when the signal fires mid-stream', async () => {
    routes.clear();
    routes.set('/chat/completions', (_r, _b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
      // never ends
    });
    const ctl = new AbortController();
    const p = new OpenAICompatibleProvider('xai', 'xAI', base, 'k', fetch);
    const got: string[] = [];
    const t0 = Date.now();
    await expect(
      (async () => {
        for await (const c of p.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'fast', signal: ctl.signal })) {
          if (c.type === 'text') {
            got.push(c.text);
            ctl.abort();
          }
        }
      })(),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(got).toEqual(['first']);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('OllamaProvider (fixture)', () => {
  it('only accepts endpoints on this PC', () => {
    expect(validateLocalBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
    expect(validateLocalBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(validateLocalBaseUrl('http://192.168.1.5:11434/v1')).toBeNull();
    expect(validateLocalBaseUrl('https://ollama.example.com/v1')).toBeNull();
    expect(validateLocalBaseUrl('http://u:p@localhost:11434/v1')).toBeNull();
  });

  it('streams chat with reasoning off for fast cues, hides embedding models, and preloads the model', async () => {
    routes.clear();
    routes.set('/v1/models', (_r, _b, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen3.5:4b' }, { id: 'nomic-embed-text:latest' }] })),
    );
    routes.set('/v1/chat/completions', (_r, _b, res) =>
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'Local' } }] }), JSON.stringify({ choices: [{ delta: { content: ' answer' }, finish_reason: 'stop' }] }), '[DONE]']),
    );
    routes.set('/api/generate', (_r, _b, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"done":true,"done_reason":"load"}'));
    const p = new OllamaProvider(`${base}/v1`, fetch);
    expect((await p.listModels()).map((m) => [m.id, m.supportsText])).toEqual([['qwen3.5:4b', true], ['nomic-embed-text:latest', false]]);
    const r = await collect(p.stream({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 50, effort: 'fast', signal: new AbortController().signal }));
    expect(r.text).toBe('Local answer');
    expect(JSON.parse(seen[seen.length - 1]!.body)).toMatchObject({ model: 'qwen3.5:4b', stream: true, reasoning_effort: 'none' });
    await p.preconnect(undefined, 'qwen3.5:4b');
    const warm = seen[seen.length - 1]!;
    expect(warm.url).toBe('/api/generate');
    expect(JSON.parse(warm.body)).toEqual({ model: 'qwen3.5:4b', prompt: '', keep_alive: '30m', stream: false });
  });
});

describe('Streaming STT adapters (fixture WebSocket servers)', () => {
  it('Gemini Live: setup → setupComplete, base64 audio, interim/final/turnComplete, audioStreamEnd', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    const received: unknown[] = [];
    let url = '';
    wss.on('connection', (ws, req) => {
      url = req.url ?? '';
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
        if (msg.realtimeInput?.audio) {
          ws.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'how do' } } }));
          ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'How do you scale it?' } } }));
          ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        }
      });
    });
    const events: string[] = [];
    const stt = new GeminiLiveTranscriber('gkey', `ws://127.0.0.1:${port}/live`, 'gemini-3.5-transcribe-live');
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const s = await stt.open(
      { language: 'en-US', vocabulary: ['Kafka'], geminiMode: 'VERBATIM', endpointingMs: 600 },
      {
        onInterim: (t) => events.push(`i:${t}`),
        onFinalSegment: (t) => events.push(`f:${t}`),
        onUtteranceEnd: () => {
          events.push('end');
          ended();
        },
        onError: (e) => events.push(`err:${e.code}`),
        onClose: () => undefined,
      },
    );
    expect(url).toContain('key=gkey');
    expect(s.sendAudio(Buffer.alloc(3200, 1))).toBe(true);
    await done;
    s.endOfSpeech();
    await new Promise((r) => setTimeout(r, 50));
    s.close();
    wss.close();
    const setup = (received[0] as { setup: Record<string, unknown> }).setup;
    expect(setup).toMatchObject({
      model: 'models/gemini-3.5-transcribe-live',
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { mode: 'VERBATIM', languageCodes: ['en-US'], customVocabulary: ['Kafka'] },
    });
    const audio = (received[1] as { realtimeInput: { audio: { mimeType: string; data: string } } }).realtimeInput.audio;
    expect(audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(audio.data, 'base64').length).toBe(3200);
    expect(received.some((m) => (m as { realtimeInput?: { audioStreamEnd?: boolean } }).realtimeInput?.audioStreamEnd)).toBe(true);
    expect(events).toEqual(['i:how do', 'f:How do you scale it?', 'end']);
  });

  it('xAI: bearer header, query config, binary audio, partial/final/speech_final', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    let auth = '';
    let url = '';
    let binaryBytes = 0;
    wss.on('connection', (ws, req) => {
      auth = String(req.headers.authorization);
      url = req.url ?? '';
      ws.send(JSON.stringify({ type: 'transcript.created' }));
      ws.on('message', (raw, isBinary) => {
        if (isBinary) {
          binaryBytes += (raw as Buffer).length;
          ws.send(JSON.stringify({ type: 'transcript.partial', text: 'what is', is_final: false, speech_final: false }));
          ws.send(JSON.stringify({ type: 'transcript.partial', text: 'What is a mutex?', is_final: true, speech_final: true }));
        }
      });
    });
    const events: string[] = [];
    const stt = new XaiStreamingTranscriber('xai-key', `ws://127.0.0.1:${port}/v1/stt`);
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const s = await stt.open(
      { language: 'en-US', vocabulary: ['mutex'], geminiMode: 'VERBATIM', endpointingMs: 500 },
      {
        onInterim: (t) => t && events.push(`i:${t}`),
        onFinalSegment: (t) => events.push(`f:${t}`),
        onUtteranceEnd: () => {
          events.push('end');
          ended();
        },
        onError: (e) => events.push(`err:${e.code}`),
        onClose: () => undefined,
      },
    );
    s.sendAudio(Buffer.alloc(3200));
    await done;
    s.close();
    wss.close();
    expect(auth).toBe('Bearer xai-key');
    expect(url).toContain('model=grok-voice-transcribe-2.0');
    expect(url).toContain('sample_rate=16000');
    expect(url).toContain('interim_results=true');
    expect(url).toContain('endpointing=500');
    expect(url).toContain('language=en');
    expect(url).toContain('keyterm=mutex');
    expect(binaryBytes).toBe(3200);
    expect(events).toEqual(['i:what is', 'f:What is a mutex?', 'end']);
  });

  it('maps a rejected handshake (HTTP 401) to invalid_key', async () => {
    const srv = createServer((_req, res) => res.writeHead(401).end('{"error":{"message":"Incorrect API key"}}'));
    srv.on('upgrade', (_req, socket) => {
      const body = '{"error":{"message":"Incorrect API key"}}';
      socket.end(`HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const stt = new XaiStreamingTranscriber('bad', `ws://127.0.0.1:${port}/v1/stt`);
    await expect(
      stt.open({ language: '', vocabulary: [], geminiMode: 'VERBATIM', endpointingMs: 400 }, { onInterim() {}, onFinalSegment() {}, onUtteranceEnd() {}, onError() {}, onClose() {} }),
    ).rejects.toMatchObject({ code: 'invalid_key' });
    srv.close();
  });
});
