/**
 * FIXTURE tests for the Hirora Cloud relay: the upstream (Groq) is an injected fake
 * fetch, so these check auth, validation, sanitising and streaming pass-through only.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module without type declarations
import { CHAT_MODELS, handleChat, handleHealth, handleModels, handleTranscription } from './relay.mjs';

const env = { HIRORA_ACCESS_CODE: 'friends-code, second-code', GROQ_API_KEY: 'gsk_TEST_ONLY' };
const auth = (code = 'friends-code') => ({ authorization: `Bearer ${code}`, 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` });

function fakeUpstream(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  };
  return { f, calls };
}

describe('Hirora Cloud relay (fixture upstream)', () => {
  it('rejects missing or wrong access codes and refuses to run unconfigured', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    expect((await handleChat(new Request('http://x/v1/chat/completions', { method: 'POST', body }), env)).status).toBe(401);
    expect((await handleChat(new Request('http://x', { method: 'POST', headers: auth('nope'), body }), env)).status).toBe(401);
    expect((await handleChat(new Request('http://x', { method: 'POST', headers: auth(), body }), { GROQ_API_KEY: 'k' })).status).toBe(503);
    expect((await handleChat(new Request('http://x', { method: 'POST', headers: auth(), body }), { HIRORA_ACCESS_CODE: 'friends-code' })).status).toBe(503);
    const h = await (await handleHealth(env)).json();
    expect(h).toEqual({ ok: true, service: 'hirora-cloud', upstreamConfigured: true, accessCodeConfigured: true });
  });

  it('forwards a cleaned streaming request with the server key and streams the body back', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const { f, calls } = fakeUpstream(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const res = await handleChat(
      new Request('http://x', {
        method: 'POST',
        headers: auth('second-code'),
        body: JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 99999, reasoning_effort: 'low', tools: [{ evil: true }] }),
      }),
      env,
      f,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(sse);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer gsk_TEST_ONLY');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toEqual({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 4096,
      reasoning_effort: 'low',
      include_reasoning: false,
    });
  });

  it('rejects unknown models and oversize bodies', async () => {
    const r1 = await handleChat(new Request('http://x', { method: 'POST', headers: auth(), body: JSON.stringify({ model: 'some/expensive-model', messages: [{ role: 'user', content: 'x' }] }) }), env);
    expect(r1.status).toBe(400);
    expect(CHAT_MODELS[0]).toBe('openai/gpt-oss-20b');
    const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(250_000) }] });
    expect((await handleChat(new Request('http://x', { method: 'POST', headers: auth(), body: big }), env)).status).toBe(413);
  });

  it('hides the owner organisation id in upstream errors and keeps retry-after', async () => {
    const { f } = fakeUpstream(
      new Response(JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_01abcdefghijklmnop` on tokens per minute' } }), {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
    );
    const res = await handleChat(new Request('http://x', { method: 'POST', headers: auth(), body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) }), env, f);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    const j = await res.json();
    expect(j.error.message).not.toContain('org_01abcdefghijklmnop');
    expect(j.error.code).toBe('rate_limit_exceeded');
  });

  it('forwards transcription audio as multipart with verbose_json', async () => {
    const { f, calls } = fakeUpstream(new Response(JSON.stringify({ text: 'hello there', segments: [] }), { status: 200 }));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(3200)], { type: 'audio/wav' }), 'a.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');
    const res = await handleTranscription(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer friends-code' }, body: form }), env, f);
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('hello there');
    const sent = calls[0]!.init.body as FormData;
    expect(sent.get('response_format')).toBe('verbose_json');
    expect(sent.get('language')).toBe('en');
    expect((sent.get('file') as Blob).size).toBe(3200);
  });

  it('lists models only for callers with the code', async () => {
    expect((await handleModels(new Request('http://x'), env)).status).toBe(401);
    const list = await (await handleModels(new Request('http://x', { headers: auth() }), env)).json();
    expect(list.data.map((m: { id: string }) => m.id)).toContain('whisper-large-v3-turbo');
  });
});
