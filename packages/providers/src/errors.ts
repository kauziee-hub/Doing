import type { ProviderErrorCode } from '@doing/contracts';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly provider: string;

  constructor(provider: string, code: ProviderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.retryable = code === 'network' || code === 'timeout' || code === 'server_error' || code === 'rate_limited';
  }
}

/** Never let raw provider bodies (which might echo request data) grow unbounded or leak keys. */
export function sanitizeProviderMessage(raw: string): string {
  return raw
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[key]')
    .replace(/\bAQ\.[A-Za-z0-9_-]{30,}/g, '[key]')
    .replace(/\b(?:xai|sk)-[A-Za-z0-9_-]{16,}/g, '[key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [key]')
    .replace(/key=[^&\s"]+/gi, 'key=[key]')
    .slice(0, 400);
}

export function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const err = (j.error ?? j) as Record<string, unknown> | string;
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
    if (typeof j.message === 'string') return j.message;
  } catch {
    /* not json */
  }
  return body;
}

export function mapHttpError(provider: string, status: number, body: string): ProviderError {
  const msg = sanitizeProviderMessage(extractErrorMessage(body) || `HTTP ${status}`);
  const lower = msg.toLowerCase();
  let code: ProviderErrorCode;
  if (status === 401) code = 'invalid_key';
  else if (status === 400 && /api key not valid|invalid api key|api_key_invalid|incorrect api key/.test(lower)) code = 'invalid_key';
  else if (status === 402 || /insufficient (balance|credit|quota)|billing|credits/.test(lower)) code = 'quota_exceeded';
  else if (status === 403) code = /quota|billing|credit/.test(lower) ? 'quota_exceeded' : 'permission_denied';
  else if (status === 404) code = 'model_not_found';
  else if (status === 429) code = /quota|exhausted|exceeded your current/.test(lower) ? 'quota_exceeded' : 'rate_limited';
  else if (status === 408 || status === 504) code = 'timeout';
  else if (status >= 500) code = 'server_error';
  else if (status === 400 || status === 422)
    code = /model/.test(lower) && /not (found|exist|available)/.test(lower) && !/think|parameter|field|argument|level/.test(lower) ? 'model_not_found' : 'bad_request';
  else code = 'unknown';
  return new ProviderError(provider, code, msg, status);
}

export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError') return new ProviderError(provider, 'aborted', 'Request cancelled');
  if (e?.name === 'TimeoutError') return new ProviderError(provider, 'timeout', 'Request timed out');
  const causeCode = e?.cause?.code ?? '';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|ENETUNREACH/.test(causeCode) || /fetch failed|network/i.test(e?.message ?? '')) {
    return new ProviderError(provider, 'network', sanitizeProviderMessage(`${e?.message ?? 'Network error'} ${causeCode}`.trim()));
  }
  return new ProviderError(provider, 'unknown', sanitizeProviderMessage(e?.message ?? String(err)));
}
