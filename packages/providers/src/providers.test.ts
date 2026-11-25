/**
 * FIXTURE TESTS: a local HTTP server speaks the OpenAI-compatible chat SSE format
 * that Hirora's Ollama runtime serves. They verify our parsing, error mapping and
 * retries; they are not evidence that a real model answers well. Fixtures are
 * never used by the app at runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SseParser } from './sse';
import { mapHttpError } from './errors';
import { OllamaProvider, isContextOverflowMessage, validateLocalBaseUrl } from './openaiCompatible';
import { createAnswerProvider, createTranscriber } from './index';
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

describe('Answer engine stream (fixture)', () => {
  it('streams deltas, ignores reasoning_content text, stops at [DONE] and asks for no reasoning on fast cues', async () => {
    routes.clear();
    routes.set('/v1/chat/completions', (_r, _b, res) =>
      sse(res, [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Foo' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Bar' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
        '[DONE]',
        JSON.stringify({ choices: [{ delta: { content: 'AFTER-DONE' } }] }),
      ]),
    );
    const p = new OllamaProvider(`${base}/v1`, fetch);
    const r = await collect(p.stream({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 20, temperature: 0.2, effort: 'fast', signal: new AbortController().signal }));
    expect(r.text).toBe('FooBar');
    expect(r.chunks.some((c) => c.type === 'reasoning')).toBe(true);
    const body = JSON.parse(seen[seen.length - 1]!.body);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true }, reasoning_effort: 'none', max_tokens: 20 });
  });

  it('retries once without optional extras when the model rejects them', async () => {
    routes.clear();
    let n = 0;
    routes.set('/v1/chat/completions', (_r, body, res) => {
      n++;
      if (JSON.parse(body).reasoning_effort) {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'unknown field reasoning_effort' } }));
        return;
      }
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    const p = new OllamaProvider(`${base}/v1`, fetch);
    const r = await collect(p.stream({ model: 'x', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'fast', signal: new AbortController().signal }));
    expect(r.text).toBe('ok');
    expect(n).toBe(2);
    // Remembered: the next request goes without them straight away.
    n = 0;
    await collect(p.stream({ model: 'x', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'fast', signal: new AbortController().signal }));
    expect(n).toBe(1);
  });

  it('keeps reasoning off after a prompt that is too long for the context', async () => {
    routes.clear();
    let tooLong = true;
    const bodies: Array<Record<string, unknown>> = [];
    routes.set('/v1/chat/completions', (_r, body, res) => {
      bodies.push(JSON.parse(body));
      if (tooLong) {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'the request exceeds the available context size, try increasing it' } }));
        return;
      }
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    const p = new OllamaProvider(`${base}/v1`, fetch);
    const req = () => p.stream({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'fast', signal: new AbortController().signal });
    await expect(collect(req())).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(1); // no pointless retry without the fields
    tooLong = false;
    const r = await collect(req());
    expect(r.text).toBe('ok');
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'none' });
  });

  it('does not forget the fields when the retry without them fails too', async () => {
    routes.clear();
    let broken = true;
    const bodies: Array<Record<string, unknown>> = [];
    routes.set('/v1/chat/completions', (_r, body, res) => {
      bodies.push(JSON.parse(body));
      if (broken) {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'bad request' } }));
        return;
      }
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    const p = new OllamaProvider(`${base}/v1`, fetch);
    const req = () => p.stream({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 5, effort: 'fast', signal: new AbortController().signal });
    await expect(collect(req())).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(2);
    broken = false;
    await collect(req());
    expect(bodies[2]).toMatchObject({ reasoning_effort: 'none' });
  });

  it('recognises the engine wording for an over-long prompt', () => {
    expect(isContextOverflowMessage('prompt is longer than the context length')).toBe(true);
    expect(isContextOverflowMessage('the request exceeds the available context size, try increasing it')).toBe(true);
    expect(isContextOverflowMessage('unknown field reasoning_effort')).toBe(false);
  });

  it('aborts promptly when the signal fires mid-stream', async () => {
    routes.clear();
    routes.set('/v1/chat/completions', (_r, _b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}

`);
      // never ends
    });
    const ctl = new AbortController();
    const p = new OllamaProvider(`${base}/v1`, fetch);
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

  it('only builds engines that live on this PC', () => {
    expect(() => createAnswerProvider({ baseUrl: 'https://api.example.com/v1' })).toThrow(/on this PC/);
    expect(() => createTranscriber({ url: 'http://10.0.0.2:8178' })).toThrow(/on this PC/);
    expect(createAnswerProvider().id).toBe('ollama');
    expect(createTranscriber().id).toBe('local-whisper');
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
