import type {
  AnswerRecord,
  AnswerSource,
  AppSettings,
  Mode,
  PerfSample,
  PersonalProfile,
  ProviderErrorCode,
  ProviderId,
  RetrievedChunk,
  SessionProfile,
  TranscriptSegment,
  Usage,
} from '@hirora/contracts';
import { PROVIDER_ERROR_HINTS } from '@hirora/contracts';
import { ProviderError, toProviderError } from '@hirora/providers';
import type { ContentPart, TextModelProvider } from '@hirora/providers';
import { buildMessages } from './prompt';
import type { MemoryTurn } from './prompt';

export interface ResolvedProvider {
  provider: TextModelProvider;
  model: string;
  deepModel: string;
}

export interface AnswerEngineDeps {
  settings(): AppSettings;
  resolveProvider(id: ProviderId): ResolvedProvider | null;
  retrieve(question: string, signal: AbortSignal): Promise<{ chunks: RetrievedChunk[]; ms: number }>;
  context(): { personal: PersonalProfile | null; session: SessionProfile | null; transcript: TranscriptSegment[] };
  budgetCheck(): { ok: true } | { ok: false; reason: string };
  recordUsage(provider: ProviderId, model: string, usage: Usage | null): { costUsd: number | null };
  perf(sample: PerfSample): void;
  emit(rec: AnswerRecord): void;
  emitDelta(requestId: string, delta: string, seq: number): void;
  onProviderResult?(provider: ProviderId, error: ProviderError | null): void;
  now?: () => number;
}

export interface AskInput {
  question: string;
  origin: AnswerRecord['questionSource'];
  mode?: Mode;
  depth?: 'fast' | 'deep';
  /** Wall time (ms) when the question finished (utterance end / submit). */
  questionEndedAt?: number;
  images?: ContentPart[];
  instruction?: string;
  priorAnswer?: string;
  /** Use the conversation memory for follow-ups. */
  useMemory?: boolean;
}

interface Inflight {
  requestId: string;
  controller: AbortController;
  record: AnswerRecord;
}

const FATAL_FOR_RETRY: ProviderErrorCode[] = ['invalid_key', 'permission_denied', 'quota_exceeded', 'model_not_found', 'content_filtered', 'bad_request', 'aborted', 'not_configured', 'budget_exceeded'];
const DELTA_FLUSH_MS = 33;

let reqCounter = 0;
function newRequestId(): string {
  reqCounter = (reqCounter + 1) % 1_000_000;
  return `req-${Date.now().toString(36)}-${reqCounter.toString(36)}`;
}

/**
 * Runs one answer at a time. A new ask aborts the previous request; every emit
 * is guarded by request id so late chunks from an aborted request can never
 * overwrite a newer answer.
 */
export class AnswerEngine {
  private current: Inflight | null = null;
  private readonly memory: MemoryTurn[] = [];
  private readonly history = new Map<string, AnswerRecord>();
  private readonly now: () => number;

  constructor(private readonly deps: AnswerEngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  get currentRequestId(): string | null {
    return this.current?.requestId ?? null;
  }

  getRecord(id: string): AnswerRecord | undefined {
    return this.history.get(id);
  }

  cancel(reason: 'user' | 'superseded' = 'user'): boolean {
    const c = this.current;
    if (!c) return false;
    this.current = null;
    c.controller.abort(new ProviderError('engine', 'aborted', reason === 'user' ? 'Cancelled by user' : 'Superseded by a newer question'));
    if (c.record.status !== 'done' && c.record.status !== 'error') {
      c.record.status = 'cancelled';
      c.record.error = reason === 'user' ? 'Cancelled' : 'Superseded by a newer question';
      this.deps.emit({ ...c.record });
    }
    return true;
  }

  clearMemory(): void {
    this.memory.length = 0;
  }

  ask(input: AskInput): string {
    this.cancel('superseded');
    const settings = this.deps.settings();
    const requestId = newRequestId();
    const controller = new AbortController();
    const record: AnswerRecord = {
      requestId,
      question: input.question,
      questionSource: input.origin,
      mode: input.mode ?? settings.answer.mode,
      depth: input.depth ?? 'fast',
      provider: null,
      model: null,
      usedFallback: false,
      status: 'queued',
      text: '',
      error: null,
      errorCode: null,
      sources: [],
      createdAt: this.now(),
      questionEndedAt: input.questionEndedAt ?? this.now(),
      firstTokenMs: null,
      totalMs: null,
      usage: null,
      costUsd: null,
    };
    const inflight: Inflight = { requestId, controller, record };
    this.current = inflight;
    this.history.set(requestId, record);
    if (this.history.size > 200) this.history.delete(this.history.keys().next().value as string);
    this.deps.emit({ ...record });
    void this.run(inflight, input, settings);
    return requestId;
  }

  private isCurrent(id: string): boolean {
    return this.current?.requestId === id;
  }

  private fail(f: Inflight, err: ProviderError): void {
    if (!this.isCurrent(f.requestId)) return;
    f.record.status = err.code === 'aborted' ? 'cancelled' : 'error';
    f.record.errorCode = err.code;
    f.record.error = `${err.message}${err.code !== 'aborted' ? ` — ${PROVIDER_ERROR_HINTS[err.code]}` : ''}`;
    f.record.totalMs = this.now() - f.record.createdAt;
    this.deps.emit({ ...f.record });
    this.current = null;
  }

  private async run(f: Inflight, input: AskInput, settings: AppSettings): Promise<void> {
    const t0 = this.now();
    const depth = f.record.depth;
    const budget = this.deps.budgetCheck();
    if (!budget.ok) {
      this.fail(f, new ProviderError('engine', 'budget_exceeded', budget.reason));
      return;
    }
    const primaryId = settings.answer.primaryProvider;
    const chain: ProviderId[] = [];
    if (primaryId) chain.push(primaryId);
    const fb = settings.answer.fallbackProvider;
    if (fb && fb !== primaryId) chain.push(fb);
    const resolved = chain.map((id) => ({ id, r: this.deps.resolveProvider(id) })).filter((x) => x.r !== null) as Array<{ id: ProviderId; r: ResolvedProvider }>;
    if (resolved.length === 0) {
      this.fail(f, new ProviderError('engine', 'not_configured', 'No answer provider with a saved key and selected model'));
      return;
    }

    // Retrieval (local, fast). Failure never blocks answering.
    f.record.status = 'retrieving';
    this.deps.emit({ ...f.record });
    let evidence: RetrievedChunk[] = [];
    if (settings.privacy.includeDocumentsInPrompts) {
      try {
        const r = await this.deps.retrieve(input.question, f.controller.signal);
        evidence = r.chunks;
        this.deps.perf({ stage: 'retrieval', ms: r.ms, at: this.now(), provider: null, model: null, label: f.record.mode });
      } catch {
        evidence = [];
      }
    }
    if (!this.isCurrent(f.requestId)) return;
    f.record.sources = evidence.map((c, i): AnswerSource => ({
      label: `S${i + 1}`,
      documentTitle: c.documentTitle,
      page: c.page,
      evidence: c.evidence,
      snippet: c.text.slice(0, 280),
    }));

    const ctx = this.deps.context();
    const messages = buildMessages({
      question: input.question,
      questionOrigin:
        input.origin === 'typed' ? 'typed by the user' : input.origin === 'clipboard' ? 'from clipboard, approved by the user' : input.origin === 'screen' ? 'about the attached screenshot, approved by the user' : `heard on ${input.origin === 'mic' ? 'microphone' : 'system audio'}`,
      mode: f.record.mode,
      depth,
      settings: settings.answer,
      includeProfile: settings.privacy.includeProfileInPrompts,
      personal: ctx.personal,
      session: ctx.session,
      evidence,
      recentTranscript: input.origin === 'typed' || input.origin === 'clipboard' ? ctx.transcript.slice(-3) : ctx.transcript,
      memory: input.useMemory === false ? [] : this.memory.slice(-settings.answer.memoryTurns),
      images: input.images,
      instruction: input.instruction,
      priorAnswer: input.priorAnswer,
    });

    let lastErr: ProviderError | null = null;
    for (let i = 0; i < resolved.length; i++) {
      const { id, r } = resolved[i]!;
      const model = depth === 'deep' && r.deepModel ? r.deepModel : r.model;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.isCurrent(f.requestId)) return;
        f.record.provider = id;
        f.record.model = model;
        f.record.usedFallback = i > 0;
        f.record.status = 'waiting';
        f.record.error = i > 0 && lastErr ? `Primary failed (${lastErr.code}); using fallback` : null;
        this.deps.emit({ ...f.record });
        const result = await this.streamOnce(f, r.provider, id, model, messages, settings, depth, input.questionEndedAt ?? t0);
        // Superseded or cancelled while streaming: say nothing more about this request.
        if (result !== 'ok' && !this.isCurrent(f.requestId)) return;
        if (result === 'ok') {
          this.deps.onProviderResult?.(id, null);
          return;
        }
        if (result === 'stale') return;
        lastErr = result;
        this.deps.onProviderResult?.(id, result);
        // Never retry once text was shown (would duplicate/garble output).
        if (f.record.text.length > 0) {
          this.fail(f, result);
          return;
        }
        if (FATAL_FOR_RETRY.includes(result.code)) break; // try fallback, not same provider
        if (attempt === 0 && result.retryable) continue; // one safe retry
        break;
      }
    }
    this.fail(f, lastErr ?? new ProviderError('engine', 'unknown', 'All providers failed'));
  }

  private async streamOnce(
    f: Inflight,
    provider: TextModelProvider,
    providerId: ProviderId,
    model: string,
    messages: ReturnType<typeof buildMessages>,
    settings: AppSettings,
    depth: 'fast' | 'deep',
    questionEndedAt: number,
  ): Promise<'ok' | 'stale' | ProviderError> {
    const attemptCtl = new AbortController();
    const onParentAbort = () => attemptCtl.abort(f.controller.signal.reason);
    f.controller.signal.addEventListener('abort', onParentAbort, { once: true });
    let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => attemptCtl.abort(new ProviderError(providerId, 'timeout', `No response within ${settings.answer.firstTokenTimeoutMs} ms`)),
      depth === 'deep' ? settings.answer.firstTokenTimeoutMs * 3 : settings.answer.firstTokenTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => attemptCtl.abort(new ProviderError(providerId, 'timeout', `Answer exceeded ${settings.answer.totalTimeoutMs} ms`)),
      settings.answer.totalTimeoutMs,
    );
    const reqStart = this.now();
    let usage: Usage | null = null;
    let pending = '';
    let seq = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pending || !this.isCurrent(f.requestId)) return;
      this.deps.emitDelta(f.requestId, pending, seq++);
      pending = '';
    };
    try {
      for await (const chunk of provider.stream({
        model,
        messages,
        maxOutputTokens: depth === 'deep' ? settings.answer.deepMaxOutputTokens : settings.answer.maxOutputTokens,
        temperature: settings.answer.temperature,
        effort: depth,
        signal: attemptCtl.signal,
      })) {
        if (!this.isCurrent(f.requestId)) return 'stale';
        if (chunk.type === 'text') {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
            const now = this.now();
            f.record.firstTokenMs = now - f.record.createdAt;
            f.record.status = 'streaming';
            this.deps.emit({ ...f.record });
            this.deps.perf({ stage: 'request_to_first_token', ms: now - reqStart, at: now, provider: providerId, model, label: depth });
            this.deps.perf({ stage: 'question_to_first_token', ms: now - questionEndedAt, at: now, provider: providerId, model, label: f.record.questionSource });
          }
          f.record.text += chunk.text;
          pending += chunk.text;
          if (!flushTimer) flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
        } else if (chunk.type === 'reasoning') {
          // Keep the first-token timer generous while the model is thinking.
          if (firstTokenTimer && f.record.status !== 'streaming') {
            f.record.status = 'waiting';
          }
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        }
      }
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      if (!this.isCurrent(f.requestId)) return 'stale';
      if (!f.record.text.trim()) {
        return new ProviderError(providerId, 'server_error', 'Provider returned an empty answer');
      }
      const end = this.now();
      f.record.status = 'done';
      f.record.totalMs = end - f.record.createdAt;
      f.record.usage = usage;
      f.record.costUsd = this.deps.recordUsage(providerId, model, usage).costUsd;
      this.deps.perf({ stage: 'answer_total', ms: end - reqStart, at: end, provider: providerId, model, label: depth });
      this.deps.emit({ ...f.record });
      this.memory.push({ question: f.record.question, answer: f.record.text });
      if (this.memory.length > 12) this.memory.shift();
      this.current = null;
      return 'ok';
    } catch (err) {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      const reason = attemptCtl.signal.reason;
      if (reason instanceof ProviderError) return reason;
      return toProviderError(providerId, err);
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      f.controller.signal.removeEventListener('abort', onParentAbort);
    }
  }
}
