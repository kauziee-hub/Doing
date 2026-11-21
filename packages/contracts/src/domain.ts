import { z } from 'zod';
import { AudioSourceSchema, ModeSchema, ProviderIdSchema, SttProviderIdSchema } from './settings';
import type { AudioSource, Mode, ProviderId, SttProviderId } from './settings';

// ───────────────────────────── Providers ─────────────────────────────

export type ProviderErrorCode =
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'model_not_found'
  | 'bad_request'
  | 'content_filtered'
  | 'server_error'
  | 'aborted'
  | 'not_configured'
  | 'budget_exceeded'
  | 'unknown';

export const PROVIDER_ERROR_HINTS: Record<ProviderErrorCode, string> = {
  invalid_key: 'The API key was rejected. Re-enter it in Settings → Providers.',
  permission_denied: 'The key is valid but not allowed to use this model or feature.',
  quota_exceeded: 'Provider quota or credit balance is exhausted. Check your provider console.',
  rate_limited: 'Rate limited by the provider. Hirora will back off briefly.',
  timeout: 'The provider did not respond in time.',
  network: 'Network error — check your connection or proxy.',
  model_not_found: 'The selected model is not available for this key. Pick another in Settings.',
  bad_request: 'The provider rejected the request format.',
  content_filtered: 'The provider blocked this content.',
  server_error: 'The provider returned a server error.',
  aborted: 'Cancelled.',
  not_configured: 'No provider configured. Add an API key in Settings → Providers.',
  budget_exceeded: 'Your Hirora budget limit was reached. Adjust it in Settings → Budget.',
  unknown: 'Unexpected provider error.',
};

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  /** True when the provider reports text generation support (or it cannot tell). */
  supportsText: boolean;
  supportsImages?: boolean;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export const ProviderHealthSchema = z.object({
  provider: ProviderIdSchema,
  hasKey: z.boolean(),
  status: z.enum(['unknown', 'ok', 'error', 'checking', 'backoff']),
  lastError: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastCheckedAt: z.number().nullable(),
  backoffUntil: z.number().nullable(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

// ───────────────────────────── Knowledge ─────────────────────────────

export const DOC_KINDS = ['resume', 'project', 'job_description', 'company', 'notes', 'code', 'other'] as const;
export const DocKindSchema = z.enum(DOC_KINDS);
export type DocKind = z.infer<typeof DocKindSchema>;

/** Trust class used by the answer engine to separate first-person facts from background. */
export const EVIDENCE_CLASSES = ['my_facts', 'company_job', 'background'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export function evidenceClassForKind(kind: DocKind): EvidenceClass {
  switch (kind) {
    case 'resume':
    case 'project':
      return 'my_facts';
    case 'job_description':
    case 'company':
      return 'company_job';
    default:
      return 'background';
  }
}

export interface DocumentSummary {
  id: string;
  title: string;
  fileName: string;
  kind: DocKind;
  mime: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  chunkCount: number;
  charCount: number;
  createdAt: number;
  modifiedAt: number | null;
  status: 'indexed' | 'error';
  error: string | null;
  embedded: boolean;
  profileId: string | null;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  fileName: string;
  kind: DocKind;
  evidence: EvidenceClass;
  page: number | null;
  section: string | null;
  ordinal: number;
  text: string;
  score: number;
  matchedBy: Array<'fts' | 'vector' | 'card' | 'profile'>;
}

export const ProjectCardSchema = z.object({
  id: z.string().max(64),
  title: z.string().min(1).max(200),
  role: z.string().max(200).default(''),
  technologies: z.array(z.string().max(60)).max(60).default([]),
  outcomes: z.string().max(4000).default(''),
  evidence: z.string().max(4000).default(''),
  star: z
    .object({
      situation: z.string().max(4000).default(''),
      task: z.string().max(4000).default(''),
      action: z.string().max(4000).default(''),
      result: z.string().max(4000).default(''),
    })
    .prefault({}),
  visibility: z.enum(['use_in_answers', 'private']).default('use_in_answers'),
  updatedAt: z.number().default(0),
});
export type ProjectCard = z.infer<typeof ProjectCardSchema>;

export const PersonalProfileSchema = z.object({
  fullName: z.string().max(120).default(''),
  headline: z.string().max(300).default(''),
  summary: z.string().max(6000).default(''),
  skills: z.array(z.string().max(60)).max(200).default([]),
  speakingStyle: z.string().max(500).default(''),
});
export type PersonalProfile = z.infer<typeof PersonalProfileSchema>;

export const SessionProfileSchema = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(120),
  company: z.string().max(200).default(''),
  role: z.string().max(200).default(''),
  interviewType: z.string().max(200).default(''),
  jobDescription: z.string().max(20_000).default(''),
  companyNotes: z.string().max(20_000).default(''),
  tone: z.string().max(200).default(''),
  answerLength: z.enum(['', 'short', 'medium', 'long']).default(''),
  technicalDepth: z.enum(['', 'basic', 'intermediate', 'expert']).default(''),
  mode: ModeSchema.nullable().default(null),
  allowedResources: z.string().max(2000).default(''),
  updatedAt: z.number().default(0),
});
export type SessionProfile = z.infer<typeof SessionProfileSchema>;

// ───────────────────────────── Live session ─────────────────────────────

export type SourceState =
  | 'off'
  | 'permission_needed'
  | 'connecting'
  | 'ready'
  | 'streaming'
  | 'muted'
  | 'reconnecting'
  | 'failed';

export interface SourceStatus {
  source: AudioSource;
  state: SourceState;
  deviceName: string | null;
  levelDbfs: number;
  sttState: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';
  sttError: string | null;
  framesSent: number;
  framesDropped: number;
  framesPadded: number;
  message: string | null;
}

export type SessionState = 'idle' | 'starting' | 'listening' | 'paused' | 'stopping' | 'error';

export interface TranscriptSegment {
  id: string;
  source: AudioSource | 'typed';
  text: string;
  final: boolean;
  startedAt: number;
  endedAt: number | null;
  isQuestion: boolean;
  questionScore: number;
}

export type AnswerStatus = 'queued' | 'retrieving' | 'waiting' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface AnswerSource {
  label: string;
  documentTitle: string;
  page: number | null;
  evidence: EvidenceClass;
  snippet: string;
}

export interface AnswerRecord {
  requestId: string;
  question: string;
  questionSource: AudioSource | 'typed' | 'clipboard' | 'screen';
  mode: Mode;
  depth: 'fast' | 'deep';
  provider: ProviderId | null;
  model: string | null;
  usedFallback: boolean;
  status: AnswerStatus;
  text: string;
  error: string | null;
  errorCode: ProviderErrorCode | null;
  sources: AnswerSource[];
  createdAt: number;
  /** When the question finished (utterance end or submit); latency is measured from here. */
  questionEndedAt: number;
  firstTokenMs: number | null;
  totalMs: number | null;
  usage: Usage | null;
  costUsd: number | null;
}

export interface LiveSnapshot {
  session: SessionState;
  sessionId: string | null;
  sessionStartedAt: number | null;
  consentAcknowledged: boolean;
  sources: SourceStatus[];
  sttProvider: SttProviderId;
  helper: { running: boolean; version: string | null; error: string | null };
  mode: Mode;
  activeProfileName: string | null;
  questionCandidate: { text: string; source: AudioSource | 'typed'; score: number } | null;
  usageToday: { answers: number; sttMinutes: number; costUsd: number | null };
}

export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transcript'), segment: z.custom<TranscriptSegment>() }),
  z.object({ type: z.literal('answer'), answer: z.custom<AnswerRecord>() }),
  z.object({
    type: z.literal('answer_delta'),
    requestId: z.string(),
    delta: z.string(),
    seq: z.number(),
  }),
  z.object({ type: z.literal('snapshot'), snapshot: z.custom<LiveSnapshot>() }),
  z.object({
    type: z.literal('levels'),
    levels: z.record(AudioSourceSchema, z.number()),
  }),
  z.object({
    type: z.literal('toast'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  }),
  z.object({ type: z.literal('command'), command: z.string(), arg: z.unknown().optional() }),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;

// ───────────────────────────── Perf ─────────────────────────────

export const PERF_STAGES = [
  'speech_end_to_final',
  'final_to_question',
  'question_gate',
  'retrieval',
  'request_to_first_token',
  'question_to_first_token',
  'question_to_first_paint',
  'answer_total',
  'hotkey_to_paint',
  'stt_first_partial',
  'app_cold_start',
  'provider_preconnect',
] as const;
export type PerfStage = (typeof PERF_STAGES)[number];

export interface PerfSample {
  stage: PerfStage;
  ms: number;
  at: number;
  provider: string | null;
  model: string | null;
  label: string | null;
}

export interface PerfSummaryRow {
  stage: PerfStage;
  provider: string | null;
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export type { AudioSource, Mode, ProviderId, SttProviderId };
export { AudioSourceSchema, ModeSchema, ProviderIdSchema, SttProviderIdSchema };
