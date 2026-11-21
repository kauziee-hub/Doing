import { mapHttpError, toProviderError, ProviderError } from './errors';
import type { FetchLike } from './types';

export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => !!s);
  return AbortSignal.any(real);
}

export async function fetchJson<T>(
  provider: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 15_000, signal, ...rest } = init;
  const sig = anySignal([signal ?? undefined, AbortSignal.timeout(timeoutMs)]);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, signal: sig });
  } catch (err) {
    throw toProviderError(provider, err);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw mapHttpError(provider, res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, 'bad_request', 'Provider returned non-JSON response', res.status);
  }
}

export async function fetchStream(
  provider: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw toProviderError(provider, err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw mapHttpError(provider, res.status, text);
  }
  if (!res.body) throw new ProviderError(provider, 'server_error', 'Empty response body', res.status);
  return res.body;
}
