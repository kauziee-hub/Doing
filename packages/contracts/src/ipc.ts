import { z } from 'zod';
import {
  ModeSchema,
  PersonalProfileSchema,
  ProjectCardSchema,
  SessionProfileSchema,
  DocKindSchema,
} from './domain';
import type {
  AnswerRecord,
  DocumentSummary,
  EngineStatus,
  LiveSnapshot,
  PerfSample,
  PerfSummaryRow,
  PersonalProfile,
  ProjectCard,
  RetrievedChunk,
  SessionProfile,
  TranscriptSegment,
} from './domain';
import type { AppSettings } from './settings';

/**
 * Request schemas for every renderer → main `invoke` channel. Main validates each
 * payload with these schemas before touching it; unknown channels are rejected
 * in both preload and main.
 */
export const IpcRequestSchemas = {
  'app:info': z.void(),
  'app:openExternal': z.object({ url: z.string().url().max(2048) }),
  'app:openDataFolder': z.void(),
  'settings:get': z.void(),
  'settings:update': z.record(z.string(), z.unknown()),
  'settings:reset': z.object({ section: z.enum(['overlay', 'hotkeys', 'all']) }),
  'engine:status': z.void(),
  'engine:setup': z.void(),
  'engine:cancel': z.void(),
  'audio:devices': z.void(),
  'audio:apps': z.void(),
  'audio:testDevice': z.object({ source: z.enum(['mic', 'system']), seconds: z.number().min(1).max(10) }),
  'session:start': z.object({ consent: z.literal(true) }),
  'session:stop': z.void(),
  'session:pause': z.void(),
  'session:resume': z.void(),
  'session:setSourceMuted': z.object({ source: z.enum(['mic', 'system', 'app']), muted: z.boolean() }),
  'session:snapshot': z.void(),
  'session:clearTranscript': z.void(),
  'ask:text': z.object({
    text: z.string().min(1).max(20_000),
    mode: ModeSchema.optional(),
    depth: z.enum(['fast', 'deep']).optional(),
    origin: z.enum(['typed', 'clipboard']).optional(),
  }),
  'ask:latest': z.void(),
  'ask:segment': z.object({ segmentId: z.string().max(64) }),
  'ask:followup': z.object({
    requestId: z.string().max(64),
    action: z.enum(['expand', 'beginner', 'concise', 'retry']),
  }),
  'ask:screen': z.object({ previewId: z.string().max(64), question: z.string().max(4000) }),
  'answer:cancel': z.void(),
  'context:readClipboard': z.void(),
  'context:captureScreen': z.object({ displayId: z.number().optional() }),
  'context:discardScreen': z.object({ previewId: z.string().max(64) }),
  'knowledge:list': z.void(),
  'knowledge:pickFiles': z.object({ kind: DocKindSchema }),
  'knowledge:ingestPaths': z.object({ kind: DocKindSchema, paths: z.array(z.string().max(1024)).max(50) }),
  'knowledge:preview': z.object({ documentId: z.string().max(64) }),
  'knowledge:delete': z.object({ documentId: z.string().max(64) }),
  'knowledge:setKind': z.object({ documentId: z.string().max(64), kind: DocKindSchema }),
  'knowledge:search': z.object({ query: z.string().min(1).max(2000) }),
  'profile:get': z.void(),
  'profile:set': PersonalProfileSchema,
  'cards:list': z.void(),
  'cards:upsert': ProjectCardSchema,
  'cards:delete': z.object({ id: z.string().max(64) }),
  'sessionProfiles:list': z.void(),
  'sessionProfiles:upsert': SessionProfileSchema,
  'sessionProfiles:delete': z.object({ id: z.string().max(64) }),
  'sessionProfiles:setActive': z.object({ id: z.string().max(64).nullable() }),
  'history:list': z.void(),
  'history:get': z.object({ sessionId: z.string().max(64) }),
  'history:delete': z.object({ sessionId: z.string().max(64) }),
  'history:deleteAll': z.void(),
  'perf:summary': z.void(),
  'perf:clear': z.void(),
  'perf:runLocalBench': z.void(),
  'overlay:toggle': z.void(),
  'overlay:setCompact': z.object({ compact: z.boolean() }),
  'overlay:setFocusable': z.object({ focusable: z.boolean() }),
  'overlay:reportPaint': z.object({ token: z.string().max(64), at: z.number() }),
  'overlay:hide': z.void(),
  'dashboard:show': z.object({ page: z.string().max(40).optional() }),
  'capture:runCheck': z.void(),
  'capture:results': z.void(),
  'capture:recordManual': z.object({
    tool: z.string().min(1).max(80),
    result: z.enum(['hidden', 'visible', 'not_verified']),
    notes: z.string().max(500).default(''),
  }),
  'data:deleteAll': z.object({ confirm: z.literal('DELETE') }),
} as const;

export type IpcChannel = keyof typeof IpcRequestSchemas;
export const IPC_CHANNELS = Object.keys(IpcRequestSchemas) as IpcChannel[];

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  osRelease: string;
  arch: string;
  userDataPath: string;
  helperPath: string | null;
  packaged: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  format: { sampleRate: number; channels: number; bits: number } | null;
}

export interface AudioAppInfo {
  pid: number;
  exe: string;
  displayName: string;
  state: string;
}

export interface ClipboardContext {
  text: string;
  truncated: boolean;
  secretFindings: SecretFinding[];
  redactedText: string;
}

export interface SecretFinding {
  kind: string;
  start: number;
  end: number;
  preview: string;
}

export interface ScreenPreview {
  previewId: string;
  dataUrl: string;
  width: number;
  height: number;
  displayLabel: string;
  capturedAt: number;
}

export interface DocumentPreview {
  document: DocumentSummary;
  chunks: Array<{ id: string; ordinal: number; page: number | null; section: string | null; text: string }>;
}

export interface IngestResult {
  fileName: string;
  ok: boolean;
  documentId: string | null;
  duplicateOf: string | null;
  error: string | null;
  chunks: number;
  ms: number;
}

export interface HistorySessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  mode: string;
  profileName: string | null;
  segmentCount: number;
  answerCount: number;
  title: string;
}

export interface HistorySessionDetail {
  session: HistorySessionSummary;
  segments: TranscriptSegment[];
  answers: AnswerRecord[];
}

export interface CaptureCheckResult {
  method: string;
  description: string;
  result: 'hidden' | 'visible' | 'error' | 'not_verified' | 'unsupported';
  detail: string;
  contentProtectionEnabled: boolean;
  testedAt: number;
  osRelease: string;
  electron: string;
}

export interface LocalBenchResult {
  label: string;
  iterations: number;
  p50: number;
  p95: number;
  unit: 'ms';
}

/** Response types for each channel (compile-time only). */
export interface IpcResponses {
  'app:info': AppInfo;
  'app:openExternal': { ok: boolean };
  'app:openDataFolder': { ok: boolean };
  'settings:get': AppSettings;
  'settings:update': AppSettings;
  'settings:reset': AppSettings;
  'engine:status': EngineStatus;
  'engine:setup': EngineStatus;
  'engine:cancel': EngineStatus;
  'audio:devices': { capture: DeviceInfo[]; render: DeviceInfo[]; error: string | null };
  'audio:apps': { apps: AudioAppInfo[]; error: string | null };
  'audio:testDevice': { ok: boolean; peakDbfs: number; frames: number; error: string | null };
  'session:start': LiveSnapshot;
  'session:stop': LiveSnapshot;
  'session:pause': LiveSnapshot;
  'session:resume': LiveSnapshot;
  'session:setSourceMuted': LiveSnapshot;
  'session:snapshot': { snapshot: LiveSnapshot; segments: TranscriptSegment[]; answers: AnswerRecord[] };
  'session:clearTranscript': { ok: boolean };
  'ask:text': { requestId: string | null; error: string | null };
  'ask:latest': { requestId: string | null; error: string | null };
  'ask:segment': { requestId: string | null; error: string | null };
  'ask:followup': { requestId: string | null; error: string | null };
  'ask:screen': { requestId: string | null; error: string | null };
  'answer:cancel': { ok: boolean };
  'context:readClipboard': ClipboardContext;
  'context:captureScreen': ScreenPreview | { error: string };
  'context:discardScreen': { ok: boolean };
  'knowledge:list': DocumentSummary[];
  'knowledge:pickFiles': IngestResult[];
  'knowledge:ingestPaths': IngestResult[];
  'knowledge:preview': DocumentPreview | null;
  'knowledge:delete': { ok: boolean };
  'knowledge:setKind': { ok: boolean };
  'knowledge:search': { results: RetrievedChunk[]; ms: number; usedVectors: boolean };
  'profile:get': PersonalProfile;
  'profile:set': PersonalProfile;
  'cards:list': ProjectCard[];
  'cards:upsert': ProjectCard[];
  'cards:delete': ProjectCard[];
  'sessionProfiles:list': { profiles: SessionProfile[]; activeId: string | null };
  'sessionProfiles:upsert': { profiles: SessionProfile[]; activeId: string | null };
  'sessionProfiles:delete': { profiles: SessionProfile[]; activeId: string | null };
  'sessionProfiles:setActive': { profiles: SessionProfile[]; activeId: string | null };
  'history:list': HistorySessionSummary[];
  'history:get': HistorySessionDetail | null;
  'history:delete': { ok: boolean };
  'history:deleteAll': { ok: boolean; deleted: number };
  'perf:summary': { rows: PerfSummaryRow[]; recent: PerfSample[]; total: number };
  'perf:clear': { ok: boolean };
  'perf:runLocalBench': LocalBenchResult[];
  'overlay:toggle': { visible: boolean };
  'overlay:setCompact': { ok: boolean };
  'overlay:setFocusable': { ok: boolean };
  'overlay:reportPaint': { ok: boolean };
  'overlay:hide': { ok: boolean };
  'dashboard:show': { ok: boolean };
  'capture:runCheck': CaptureCheckResult[];
  'capture:results': CaptureCheckResult[];
  'capture:recordManual': CaptureCheckResult[];
  'data:deleteAll': { ok: boolean };
}

export type IpcRequest<C extends IpcChannel> = z.input<(typeof IpcRequestSchemas)[C]>;

/** The single push channel main → renderer. */
export const LIVE_EVENT_CHANNEL = 'hirora:live';
