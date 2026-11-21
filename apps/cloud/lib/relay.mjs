// Hirora Cloud relay: a tiny OpenAI-compatible proxy that lets every Hirora install
// use the owner's free Groq account (open models + Whisper) with a shared access code.
// It never logs request or response content.
import { timingSafeEqual } from 'node:crypto';

export const UPSTREAM = 'https://api.groq.com/openai/v1';
/** Open models this Groq account can use (checked live 2026-11-21: Llama models return 404). First is the default. */
export const CHAT_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
export const STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
export const MAX_CHAT_BYTES = 200_000;
/** Vercel Functions accept request bodies up to 4.5 MB; 4 MB of 16 kHz WAV is ~2 minutes. */
export const MAX_AUDIO_BYTES = 4_000_000;
export const MAX_OUTPUT_TOKENS = 4096;
const PER_IP_PER_MINUTE = 60;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export function errorResponse(status, message, code = 'error', extraHeaders = {}) {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function accessCodes(env) {
  return String(env.HIRORA_ACCESS_CODE ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Returns an error Response when the caller may not use the relay, otherwise null. */
export function checkAccess(request, env) {
  const codes = accessCodes(env);
  if (codes.length === 0) return errorResponse(503, 'This Hirora Cloud server has no access code configured yet.', 'not_configured');
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !codes.some((c) => safeEqual(c, token))) return errorResponse(401, 'Wrong or missing Hirora Cloud access code.', 'invalid_api_key');
  if (!env.GROQ_API_KEY) return errorResponse(503, 'This Hirora Cloud server is not connected to its model provider yet.', 'not_configured');
  return null;
}

// Best-effort per-instance limiter; Groq's own limits are the real ceiling.
const hits = new Map();
export function rateLimited(request, now = Date.now()) {
  const ip = (request.headers.get('x-forwarded-for') ?? 'local').split(',')[0].trim();
  const minute = Math.floor(now / 60_000);
  const cur = hits.get(ip);
  if (!cur || cur.minute !== minute) {
    hits.set(ip, { minute, n: 1 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  cur.n += 1;
  return cur.n > PER_IP_PER_MINUTE;
}

/** Upstream errors can mention the owner's organisation id: pass status + a clean message only. */
async function relayError(upstream) {
  let message = `Model provider returned HTTP ${upstream.status}`;
  try {
    const j = JSON.parse(await upstream.text());
    if (j?.error?.message) message = String(j.error.message);
  } catch {
    /* non-JSON body */
  }
  message = message.replace(/\borg(?:anization)?[_ `'"]*[A-Za-z0-9_]{8,}`?/gi, 'organization').slice(0, 400);
  const headers = {};
  const retry = upstream.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  const code = upstream.status === 429 ? 'rate_limit_exceeded' : upstream.status === 401 ? 'upstream_auth' : 'upstream_error';
  // The caller's code was fine; an upstream 401 means the relay itself is misconfigured.
  return errorResponse(upstream.status === 401 ? 503 : upstream.status, message, code, headers);
}

export async function handleChat(request, env, fetchImpl = fetch) {
  if (request.method !== 'POST') return errorResponse(405, 'Use POST', 'method_not_allowed');
  const denied = checkAccess(request, env);
  if (denied) return denied;
  if (rateLimited(request)) return errorResponse(429, 'Too many requests from this network; wait a minute.', 'rate_limit_exceeded', { 'retry-after': '30' });
  const raw = await request.text();
  if (raw.length > MAX_CHAT_BYTES) return errorResponse(413, 'Request too large', 'request_too_large');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse(400, 'Body must be JSON', 'invalid_request_error');
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0 || body.messages.length > 60) {
    return errorResponse(400, 'messages must be a non-empty array', 'invalid_request_error');
  }
  const model = body.model ?? CHAT_MODELS[0];
  if (!CHAT_MODELS.includes(model)) return errorResponse(400, `Model not offered by this server. Use one of: ${CHAT_MODELS.join(', ')}`, 'model_not_found');
  const maxTokens = Math.min(Number(body.max_completion_tokens ?? body.max_tokens ?? 1024) || 1024, MAX_OUTPUT_TOKENS);
  const clean = {
    model,
    messages: body.messages,
    stream: body.stream === true,
    max_completion_tokens: maxTokens,
  };
  if (clean.stream) clean.stream_options = { include_usage: true };
  if (typeof body.temperature === 'number') clean.temperature = Math.max(0, Math.min(2, body.temperature));
  if (['low', 'medium', 'high'].includes(body.reasoning_effort) && model.startsWith('openai/gpt-oss')) clean.reasoning_effort = body.reasoning_effort;
  if (model.startsWith('openai/gpt-oss')) clean.include_reasoning = false;

  const upstream = await fetchImpl(`${UPSTREAM}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(clean),
    signal: request.signal,
  });
  if (!upstream.ok) return relayError(upstream);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? (clean.stream ? 'text/event-stream' : 'application/json'),
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

export async function handleTranscription(request, env, fetchImpl = fetch) {
  if (request.method !== 'POST') return errorResponse(405, 'Use POST', 'method_not_allowed');
  const denied = checkAccess(request, env);
  if (denied) return denied;
  if (rateLimited(request)) return errorResponse(429, 'Too many requests from this network; wait a minute.', 'rate_limit_exceeded', { 'retry-after': '30' });
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_AUDIO_BYTES + 64_000) return errorResponse(413, 'Audio too large (max ~2 minutes per request)', 'request_too_large');
  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'Body must be multipart/form-data with a "file" field', 'invalid_request_error');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return errorResponse(400, 'Missing audio "file"', 'invalid_request_error');
  if (file.size > MAX_AUDIO_BYTES) return errorResponse(413, 'Audio too large (max ~2 minutes per request)', 'request_too_large');
  const model = String(form.get('model') ?? STT_MODELS[0]);
  if (!STT_MODELS.includes(model)) return errorResponse(400, `Use one of: ${STT_MODELS.join(', ')}`, 'model_not_found');
  const out = new FormData();
  out.append('file', file, 'audio.wav');
  out.append('model', model);
  out.append('response_format', 'verbose_json');
  out.append('temperature', '0');
  const language = String(form.get('language') ?? '').trim();
  if (/^[a-z]{2}$/.test(language)) out.append('language', language);
  const prompt = String(form.get('prompt') ?? '').slice(0, 500);
  if (prompt) out.append('prompt', prompt);
  const upstream = await fetchImpl(`${UPSTREAM}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: out,
    signal: request.signal,
  });
  if (!upstream.ok) return relayError(upstream);
  return new Response(upstream.body, { status: 200, headers: JSON_HEADERS });
}

export function handleModels(request, env) {
  const denied = checkAccess(request, env);
  if (denied) return denied;
  return new Response(
    JSON.stringify({
      object: 'list',
      data: [
        ...CHAT_MODELS.map((id, i) => ({ id, object: 'model', owned_by: 'hirora-cloud', default: i === 0, kind: 'chat' })),
        ...STT_MODELS.map((id, i) => ({ id, object: 'model', owned_by: 'hirora-cloud', default: i === 0, kind: 'transcription' })),
      ],
    }),
    { status: 200, headers: JSON_HEADERS },
  );
}

export function handleHealth(env) {
  return new Response(
    JSON.stringify({ ok: true, service: 'hirora-cloud', upstreamConfigured: Boolean(env.GROQ_API_KEY), accessCodeConfigured: accessCodes(env).length > 0 }),
    { status: 200, headers: JSON_HEADERS },
  );
}
