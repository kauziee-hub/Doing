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
} from '@doing/contracts';
import { LOCAL_ENGINE, PROVIDER_ERROR_HINTS } from '@doing/contracts';
import { ProviderError, isContextOverflowMessage, toProviderError } from '@doing/providers';
import type { ContentPart, TextModelProvider } from '@doing/providers';
import { buildMessages, buildPrimingMessages, isBuildWalkthrough, missingFacts } from './prompt';
import type { MemoryTurn } from './prompt';

export interface ResolvedProvider {
  provider: TextModelProvider;
  model: string;
  deepModel: string;
}

export interface AnswerEngineDeps {
  settings(): AppSettings;
  resolveProvider(id: ProviderId): ResolvedProvider | null;
  /** `wide`: Expand or a build walkthrough on the GPU tier, which takes more passages. */
  retrieve(question: string, signal: AbortSignal, opts?: { compact?: boolean; wide?: boolean }): Promise<{ chunks: RetrievedChunk[]; ms: number }>;
  /**
   * The user's résumé as evidence, identical on every call (local models only). It goes
   * first in the prompt so the model can keep it pre-read between questions (see prime()).
   */
  stableResume?(): RetrievedChunk[];
  context(): { personal: PersonalProfile | null; session: SessionProfile | null; transcript: TranscriptSegment[] };
  /**
   * A slow (CPU) model: everything after the pre-read part of the prompt costs real time, so
   * leave out earlier answers and keep two transcript lines. Small models also tend to repeat
   * earlier answers when they see them.
   */
  lean?(): boolean;
  /** Resolves once the answer engine can take requests (e.g. still loading right after launch). */
  ready?(): Promise<void>;
  /**
   * A capture of the user's screen for this question, when it refers to something shown
   * ("add RBAC to this code"). null = no screen for this one (setting, no match, or no vision).
   */
  screen?(question: string, signal: AbortSignal): Promise<ContentPart[] | null>;
  /** Counts answers for the Home page (local engine: no cost). */
  recordUsage(provider: ProviderId, model: string, usage: Usage | null): void;
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
  /** Speculative: generating while the question may still be in progress; nothing is shown. */
  hidden: boolean;
  /** Next delta sequence number and how much of record.text the UI already has. */
  seq: number;
  emitted: number;
  firstTokenAt: number | null;
  done: boolean;
  /** Short prompt and answer budget for a local model (set when the run starts). */
  compact: boolean;
}

/** First-token limit for a request carrying a screen capture (see streamOnce). */
export const IMAGE_FIRST_TOKEN_TIMEOUT_MS = 15_000;

/**
 * Evidence characters in one prompt. The local models run with a 4K context: measured on
 * 2026-11-26, an 8,000-character résumé plus three 900-character passages and a filled-in
 * profile overflowed it, and every answer failed with "the prompt is longer than the context
 * length". The résumé comes first (it is capped lower in the app, so the cached prefix stays
 * the same), then other passages while they fit.
 */
export const EVIDENCE_PROMPT_CHARS = 7_400;
/**
 * Expand and "how did you build it" questions on the GPU tier (8K tokens per slot): up to five
 * other passages, so the architecture and data-flow sections fit next to the résumé. About 800
 * more prompt tokens, still inside 8K with Expand's 2,500 output tokens.
 */
export const WIDE_EVIDENCE_PROMPT_CHARS = 10_400;
/** Added to the search for a build walkthrough (not to the prompt). */
const WALKTHROUGH_QUERY_TERMS = 'architecture stack backend frontend database data collection fetch sync pipeline';

export function fitEvidence(first: RetrievedChunk[], rest: RetrievedChunk[], budget = EVIDENCE_PROMPT_CHARS): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const c of first) {
    if (used + c.text.length > budget) break;
    out.push(c);
    used += c.text.length;
  }
  for (const c of rest) {
    if (used + c.text.length > budget) continue;
    out.push(c);
    used += c.text.length;
  }
  return out;
}

/** Ollama's reply when the prompt doesn't fit the model's context window. */
export function isContextOverflow(e: { message: string }): boolean {
  return isContextOverflowMessage(e.message);
}

const FATAL_FOR_RETRY: ProviderErrorCode[] = ['invalid_key', 'permission_denied', 'quota_exceeded', 'model_not_found', 'content_filtered', 'bad_request', 'aborted', 'not_configured', 'budget_exceeded'];
const DELTA_FLUSH_MS = 33;
/** First answers from a local model: ~300 words, which leaves room for the prompt in a 4K context. */
const LOCAL_MAX_OUTPUT_TOKENS = 480;

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
  /** At most one hidden, speculative answer (see prefetch/commit). */
  private speculative: Inflight | null = null;
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
    this.dropPrefetch();
    this.cancel('superseded');
    return this.start(input, false);
  }

  /**
   * Starts answering `input` without showing anything, while the speaker may still be
   * talking. The answer on screen is untouched. Reveal it with commit() once the
   * question is over, or let the next prefetch/ask/dropPrefetch discard it.
   */
  prefetch(input: AskInput): string {
    this.dropPrefetch();
    return this.start(input, true);
  }

  get prefetchId(): string | null {
    return this.speculative?.requestId ?? null;
  }

  dropPrefetch(): void {
    const s = this.speculative;
    if (!s) return;
    this.speculative = null;
    s.controller.abort(new ProviderError('engine', 'aborted', 'Speculative answer dropped'));
  }

  /**
   * Shows a prefetched answer now, replacing the one on screen, with everything it
   * has generated so far. False if it is gone (dropped, failed or replaced).
   */
  commit(requestId: string, opts: { questionEndedAt: number; question?: string }): boolean {
    const f = this.speculative;
    if (!f || f.requestId !== requestId) return false;
    this.speculative = null;
    if (f.record.status === 'error' || f.record.status === 'cancelled') return false;
    this.cancel('superseded');
    const now = this.now();
    f.hidden = false;
    f.record.questionEndedAt = opts.questionEndedAt;
    if (opts.question) f.record.question = opts.question;
    if (f.firstTokenAt !== null) {
      f.record.firstTokenMs = Math.max(0, now - opts.questionEndedAt);
      this.deps.perf({ stage: 'question_to_first_token', ms: f.record.firstTokenMs, at: now, provider: f.record.provider, model: f.record.model, label: `${f.record.questionSource}:prefetched` });
      this.deps.perf({ stage: 'last_word_to_first_token', ms: f.record.firstTokenMs, at: now, provider: f.record.provider, model: f.record.model, label: `${f.record.questionSource}:prefetched` });
    }
    if (!f.done) this.current = f;
    this.deps.emit({ ...f.record, text: '' });
    if (f.record.text) {
      this.deps.emitDelta(f.requestId, f.record.text, f.seq++);
      f.emitted = f.record.text.length;
    }
    if (f.done) {
      this.deps.emit({ ...f.record });
      this.remember(f);
    }
    return true;
  }

  /**
   * Has the local answer model read the fixed start of every prompt (instructions, profile,
   * résumé) ahead of time, so answers only process the new question.
   */
  async prime(signal?: AbortSignal): Promise<boolean> {
    const settings = this.deps.settings();
    if (!this.deps.stableResume) return false;
    const r = this.deps.resolveProvider(LOCAL_ENGINE);
    if (!r) return false;
    const ctx = this.deps.context();
    const messages = buildPrimingMessages({
      depth: 'fast',
      settings: settings.answer,
      includeProfile: settings.privacy.includeProfileInPrompts,
      personal: ctx.personal,
      session: ctx.session,
      evidence: settings.privacy.includeDocumentsInPrompts ? this.deps.stableResume() : [],
    });
    try {
      for await (const chunk of r.provider.stream({ model: r.model, messages, maxOutputTokens: 1, temperature: 0, effort: 'fast', signal: signal ?? new AbortController().signal })) {
        if (chunk.type === 'done') break;
      }
      return true;
    } catch {
      return false;
    }
  }

  private remember(f: Inflight): void {
    this.memory.push({ question: f.record.question, answer: f.record.text });
    if (this.memory.length > 12) this.memory.shift();
  }

  private start(input: AskInput, hidden: boolean): string {
    const settings = this.deps.settings();
    const requestId = newRequestId();
    const controller = new AbortController();
    const record: AnswerRecord = {
      requestId,
      question: input.question,
      questionSource: input.origin,
      mode: 'assistant',
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
    const inflight: Inflight = { requestId, controller, record, hidden, seq: 0, emitted: 0, firstTokenAt: null, done: false, compact: false };
    if (hidden) this.speculative = inflight;
    else this.current = inflight;
    this.history.set(requestId, record);
    if (this.history.size > 200) this.history.delete(this.history.keys().next().value as string);
    this.show(inflight);
    void this.run(inflight, input, settings);
    return requestId;
  }

  /** Still wanted: the visible answer or the one speculative answer. */
  private isLive(f: Inflight): boolean {
    return this.current === f || this.speculative === f;
  }

  private show(f: Inflight): void {
    if (!f.hidden) this.deps.emit({ ...f.record });
  }

  private fail(f: Inflight, err: ProviderError): void {
    if (!this.isLive(f)) return;
    f.record.status = err.code === 'aborted' ? 'cancelled' : 'error';
    f.record.errorCode = err.code;
    f.record.error = `${err.message}${err.code !== 'aborted' ? ` — ${PROVIDER_ERROR_HINTS[err.code]}` : ''}`;
    f.record.totalMs = this.now() - f.record.createdAt;
    this.show(f);
    if (this.current === f) this.current = null;
    if (this.speculative === f) this.speculative = null;
  }

  private async run(f: Inflight, input: AskInput, settings: AppSettings): Promise<void> {
    const t0 = this.now();
    // A question asked while the engine is still starting waits for it instead of failing.
    if (this.deps.ready) {
      try {
        await this.deps.ready();
      } catch {
        /* the request below reports the real problem */
      }
      if (!this.isLive(f)) return;
    }
    const depth = f.record.depth;
    // The local model is fast only with short prompts: smaller résumé slice and history.
    const compact = true;
    const lean = this.deps.lean?.() ?? false;
    f.compact = compact;
    const one = this.deps.resolveProvider(LOCAL_ENGINE);
    const resolved = one ? [{ id: LOCAL_ENGINE, r: one }] : [];
    if (resolved.length === 0) {
      this.fail(f, new ProviderError('engine', 'not_configured', 'Doing is not set up yet: open Home and press Set up.'));
      return;
    }

    // Retrieval (local, fast) and, when the question points at something shown, a screen
    // capture, side by side. Neither failing blocks answering.
    f.record.status = 'retrieving';
    this.show(f);
    const screenShot: Promise<ContentPart[] | null> =
      !input.images?.length && this.deps.screen ? this.deps.screen(input.question, f.controller.signal).catch(() => null) : Promise.resolve(null);
    let evidence: RetrievedChunk[] = [];
    if (settings.privacy.includeDocumentsInPrompts) {
      try {
        // A walkthrough also looks for the architecture and data-flow sections, which rarely
        // share a word with the question ("explain the procedure you built X with").
        const walkthrough = isBuildWalkthrough(input.question);
        const wide = !lean && (depth === 'deep' || walkthrough);
        const query = walkthrough ? `${input.question} ${WALKTHROUGH_QUERY_TERMS}` : input.question;
        const r = await this.deps.retrieve(query, f.controller.signal, { compact, wide });
        const stable = compact ? (this.deps.stableResume?.() ?? []) : [];
        // Local model: the whole résumé in a fixed order first, then up to 3 other passages
        // (5 for Expand and build walkthroughs on the GPU tier, which need the details).
        const stableDocs = new Set(stable.map((c) => c.documentId));
        const budget = wide ? WIDE_EVIDENCE_PROMPT_CHARS : EVIDENCE_PROMPT_CHARS;
        evidence = stable.length ? fitEvidence(stable, r.chunks.filter((c) => !stableDocs.has(c.documentId)).slice(0, wide ? 5 : 3), budget) : fitEvidence([], r.chunks, budget);
        this.deps.perf({ stage: 'retrieval', ms: r.ms, at: this.now(), provider: null, model: null, label: f.record.mode });
      } catch {
        evidence = [];
      }
    }
    const screen = await screenShot;
    if (!this.isLive(f)) return;
    // A capture made here (`auto`/`always`) or passed in (the screen key, Ctrl+Shift+O).
    if (screen?.length || input.images?.length) f.record.usedScreen = true;
    f.record.sources = evidence.map((c, i): AnswerSource => ({
      label: `S${i + 1}`,
      documentTitle: c.documentTitle,
      page: c.page,
      evidence: c.evidence,
      snippet: c.text.slice(0, 280),
    }));

    const ctx = this.deps.context();
    const build = (ev: RetrievedChunk[]) => buildMessages({
      question: input.question,
      questionOrigin:
        input.origin === 'typed' ? 'typed by the user' : input.origin === 'clipboard' ? 'from clipboard, approved by the user' : input.origin === 'screen' ? 'about the attached screenshot, approved by the user' : `heard on ${input.origin === 'mic' ? 'microphone' : 'system audio'}`,
      mode: f.record.mode,
      depth,
      settings: settings.answer,
      includeProfile: settings.privacy.includeProfileInPrompts,
      personal: ctx.personal,
      session: ctx.session,
      evidence: ev,
      recentTranscript: lean ? ctx.transcript.slice(-2) : input.origin === 'typed' || input.origin === 'clipboard' ? ctx.transcript.slice(-3) : ctx.transcript,
      memory: input.useMemory === false || lean ? [] : this.memory.slice(-(compact ? Math.min(2, settings.answer.memoryTurns) : settings.answer.memoryTurns)),
      compact,
      missingFacts: missingFacts(input.question, [ctx.personal ? JSON.stringify(ctx.personal) : '', ...ev.map((c) => c.text)].join('\n')),
      images: input.images?.length ? input.images : (screen ?? undefined),
      instruction: input.instruction,
      priorAnswer: input.priorAnswer,
    });
    let messages = build(evidence);
    let shrunk = false;

    let lastErr: ProviderError | null = null;
    for (let i = 0; i < resolved.length; i++) {
      const { id, r } = resolved[i]!;
      const model = depth === 'deep' && r.deepModel ? r.deepModel : r.model;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.isLive(f)) return;
        f.record.provider = id;
        f.record.model = model;
        f.record.usedFallback = i > 0;
        f.record.status = 'waiting';
        f.record.error = i > 0 && lastErr ? `Primary failed (${lastErr.code}); using fallback` : null;
        this.show(f);
        const result = await this.streamOnce(f, r.provider, id, model, messages, settings, depth, input.questionEndedAt ?? t0);
        // Superseded or cancelled while streaming: say nothing more about this request.
        if (result !== 'ok' && !this.isLive(f)) return;
        if (result === 'ok') {
          this.deps.onProviderResult?.(id, null);
          return;
        }
        if (result === 'stale') return;
        lastErr = result;
        this.deps.onProviderResult?.(id, result);
        // The prompt didn't fit the model's context: once, with half the evidence (résumé first).
        if (!shrunk && f.record.text.length === 0 && isContextOverflow(result) && evidence.length > 0) {
          shrunk = true;
          evidence = fitEvidence(evidence, [], Math.floor(evidence.reduce((n, c) => n + c.text.length, 0) / 2));
          f.record.sources = f.record.sources.slice(0, evidence.length);
          messages = build(evidence);
          attempt = -1;
          continue;
        }
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
    // A request with a screen capture normally starts in 1–3 s; the engine has been seen to stall
    // on one (until cancelled), so give up sooner and let the retry (another slot) take it.
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'));
    const firstTokenMs = hasImage ? Math.min(settings.answer.firstTokenTimeoutMs, IMAGE_FIRST_TOKEN_TIMEOUT_MS) : depth === 'deep' ? settings.answer.firstTokenTimeoutMs * 3 : settings.answer.firstTokenTimeoutMs;
    let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => attemptCtl.abort(new ProviderError(providerId, 'timeout', `No response within ${firstTokenMs} ms`)),
      firstTokenMs,
    );
    const totalTimer = setTimeout(
      () => attemptCtl.abort(new ProviderError(providerId, 'timeout', `Answer exceeded ${settings.answer.totalTimeoutMs} ms`)),
      settings.answer.totalTimeoutMs,
    );
    const reqStart = this.now();
    let usage: Usage | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (f.hidden || !this.isLive(f)) return;
      const delta = f.record.text.slice(f.emitted);
      if (!delta) return;
      this.deps.emitDelta(f.requestId, delta, f.seq++);
      f.emitted = f.record.text.length;
    };
    try {
      for await (const chunk of provider.stream({
        model,
        messages,
        // A local model's whole context is ~4K tokens: keep prompt + answer inside it.
        maxOutputTokens: depth === 'deep' ? settings.answer.deepMaxOutputTokens : f.compact ? Math.min(settings.answer.maxOutputTokens, LOCAL_MAX_OUTPUT_TOKENS) : settings.answer.maxOutputTokens,
        temperature: settings.answer.temperature,
        // Thinking stays off for Expand too. With it on (2026-11-26), qwen3.5 thought through
        // Expand's whole output budget and no answer ever appeared.
        effort: 'fast',
        signal: attemptCtl.signal,
      })) {
        if (!this.isLive(f)) return 'stale';
        if (chunk.type === 'text') {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
            const now = this.now();
            f.firstTokenAt = now;
            f.record.status = 'streaming';
            this.deps.perf({ stage: 'request_to_first_token', ms: now - reqStart, at: now, provider: providerId, model, label: depth });
            if (!f.hidden) {
              // A committed prefetch measures from the real question end set at commit time.
              const endedAt = f.record.questionEndedAt ?? questionEndedAt;
              f.record.firstTokenMs = Math.max(0, now - Math.min(endedAt, f.record.createdAt));
              this.show(f);
              this.deps.perf({ stage: 'question_to_first_token', ms: Math.max(0, now - endedAt), at: now, provider: providerId, model, label: f.record.questionSource });
            }
          }
          f.record.text += chunk.text;
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
      if (!this.isLive(f)) return 'stale';
      if (!f.record.text.trim()) {
        return new ProviderError(providerId, 'server_error', 'Provider returned an empty answer');
      }
      const end = this.now();
      f.record.status = 'done';
      f.record.totalMs = end - f.record.createdAt;
      f.record.usage = usage;
      this.deps.recordUsage(providerId, model, usage);
      this.deps.perf({ stage: 'answer_total', ms: end - reqStart, at: end, provider: providerId, model, label: depth });
      f.done = true;
      if (!f.hidden) {
        this.show(f);
        this.remember(f);
      }
      if (this.current === f) this.current = null;
      // A finished hidden answer stays as `speculative` until it is committed or dropped.
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
