import { z } from 'zod';

export const PROVIDER_IDS = ['cloud', 'gemini', 'xai', 'deepseek', 'ollama', 'custom'] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Providers that run on this PC and need no API key. */
export const KEYLESS_PROVIDERS: readonly ProviderId[] = ['ollama'];
export const isKeyless = (p: ProviderId): boolean => KEYLESS_PROVIDERS.includes(p);
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
/** The project's free shared server (Vercel relay → Groq open models + Whisper). Overridable in Settings. */
export const HIRORA_CLOUD_DEFAULT_BASE_URL = 'https://hirora-one.vercel.app/v1';

export const STT_PROVIDER_IDS = ['cloud-whisper', 'gemini-live', 'xai-stt'] as const;
export const SttProviderIdSchema = z.enum(STT_PROVIDER_IDS);
export type SttProviderId = z.infer<typeof SttProviderIdSchema>;

export const AUDIO_SOURCES = ['mic', 'system', 'app'] as const;
export const AudioSourceSchema = z.enum(AUDIO_SOURCES);
export type AudioSource = z.infer<typeof AudioSourceSchema>;

export const MODES = [
  'interview_practice',
  'live_copilot',
  'coding',
  'explain',
  'general',
  'meeting_notes',
] as const;
export const ModeSchema = z.enum(MODES);
export type Mode = z.infer<typeof ModeSchema>;

export const MODE_LABELS: Record<Mode, string> = {
  interview_practice: 'Interview Practice',
  live_copilot: 'Live Authorised Copilot',
  coding: 'Coding',
  explain: 'Explain / Teach',
  general: 'General Q&A',
  meeting_notes: 'Meeting Notes',
};

export const MODE_SHORT_LABELS: Record<Mode, string> = {
  interview_practice: 'Practice',
  live_copilot: 'Copilot',
  coding: 'Coding',
  explain: 'Explain',
  general: 'Q&A',
  meeting_notes: 'Notes',
};

const Accelerator = z.string().max(64);

export const ProviderSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Fast model used for first answers. Empty = not yet selected from the live model list. */
  model: z.string().max(128).default(''),
  /** Optional slower/deeper model used by "Expand". Empty = reuse `model`. */
  deepModel: z.string().max(128).default(''),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const CustomProviderSettingsSchema = ProviderSettingsSchema.extend({
  label: z.string().max(64).default('Custom OpenAI-compatible'),
  /** Must be https:// (or http://localhost for local servers). Validated in main. */
  baseUrl: z.string().max(512).default(''),
});

/** Hirora Cloud: the access code is stored in the vault like an API key. */
export const CloudProviderSettingsSchema = ProviderSettingsSchema.extend({
  baseUrl: z.string().max(512).default(HIRORA_CLOUD_DEFAULT_BASE_URL),
});

export const LocalProviderSettingsSchema = ProviderSettingsSchema.extend({
  /** OpenAI-compatible endpoint of a local runtime. Loopback only; validated in main. */
  baseUrl: z.string().max(512).default(OLLAMA_DEFAULT_BASE_URL),
});

export const PriceSchema = z.object({
  inputPer1M: z.number().min(0).max(10_000),
  outputPer1M: z.number().min(0).max(10_000),
});

export const DEFAULT_HOTKEYS = {
  toggleOverlay: 'CommandOrControl+Shift+Space',
  askNow: 'CommandOrControl+Shift+Enter',
  toggleListening: 'CommandOrControl+Shift+L',
  pauseListening: 'CommandOrControl+Shift+P',
  cancelAnswer: 'CommandOrControl+Shift+X',
  focusAsk: 'CommandOrControl+Shift+K',
  nextMonitor: 'CommandOrControl+Shift+M',
  toggleCompact: 'CommandOrControl+Shift+E',
  screenContext: 'CommandOrControl+Shift+O',
} as const;
export type HotkeyAction = keyof typeof DEFAULT_HOTKEYS;
export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleOverlay: 'Show / hide overlay',
  askNow: 'Answer latest question now',
  toggleListening: 'Start / stop listening',
  pauseListening: 'Pause / resume listening',
  cancelAnswer: 'Cancel current answer',
  focusAsk: 'Type a question (focus Ask box)',
  nextMonitor: 'Move overlay to next monitor',
  toggleCompact: 'Compact / expanded overlay',
  screenContext: 'Screen context (preview first)',
};

export const BoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(240).max(8000),
  height: z.number().int().min(120).max(8000),
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const AppSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  onboardingComplete: z.boolean().default(false),
  providers: z
    .object({
      cloud: CloudProviderSettingsSchema.default({ enabled: false, model: '', deepModel: '', baseUrl: HIRORA_CLOUD_DEFAULT_BASE_URL }),
      gemini: ProviderSettingsSchema.default({ enabled: false, model: '', deepModel: '' }),
      xai: ProviderSettingsSchema.default({ enabled: false, model: '', deepModel: '' }),
      deepseek: ProviderSettingsSchema.default({ enabled: false, model: '', deepModel: '' }),
      ollama: LocalProviderSettingsSchema.default({ enabled: false, model: '', deepModel: '', baseUrl: OLLAMA_DEFAULT_BASE_URL }),
      custom: CustomProviderSettingsSchema.default({
        enabled: false,
        model: '',
        deepModel: '',
        label: 'Custom OpenAI-compatible',
        baseUrl: '',
      }),
    })
    .prefault({}),
  answer: z
    .object({
      primaryProvider: ProviderIdSchema.nullable().default(null),
      fallbackProvider: ProviderIdSchema.nullable().default(null),
      mode: ModeSchema.default('interview_practice'),
      length: z.enum(['short', 'medium', 'long']).default('short'),
      tone: z.string().max(200).default('confident, warm, concise'),
      format: z.enum(['talking_points', 'paragraph', 'star']).default('talking_points'),
      language: z.string().max(40).default('English'),
      technicalDepth: z.enum(['basic', 'intermediate', 'expert']).default('intermediate'),
      codingIncludeTests: z.boolean().default(true),
      autoAnswer: z.boolean().default(true),
      /** Which captured source may auto-trigger answers. The app never knows who is speaking. */
      autoAnswerSources: z.array(AudioSourceSchema).default(['system', 'app']),
      // Measured Nov 2026: Gemini flash-lite time-to-first-byte was ~8–9 s under load, so 8 s was too tight.
      firstTokenTimeoutMs: z.number().int().min(1500).max(60_000).default(20_000),
      totalTimeoutMs: z.number().int().min(5000).max(300_000).default(90_000),
      maxOutputTokens: z.number().int().min(64).max(8192).default(700),
      deepMaxOutputTokens: z.number().int().min(256).max(32_768).default(2500),
      temperature: z.number().min(0).max(2).default(0.4),
      memoryTurns: z.number().int().min(0).max(12).default(4),
    })
    .prefault({}),
  stt: z
    .object({
      provider: SttProviderIdSchema.default('cloud-whisper'),
      /** BCP-47 (Gemini) / short code (xAI). Empty string = automatic detection. */
      language: z.string().max(20).default(''),
      customVocabulary: z.array(z.string().max(50)).max(100).default([]),
      geminiMode: z.enum(['VERBATIM', 'SMART']).default('VERBATIM'),
      endpointingMs: z.number().int().min(100).max(5000).default(600),
    })
    .prefault({}),
  audio: z
    .object({
      micEnabled: z.boolean().default(true),
      systemEnabled: z.boolean().default(true),
      micDeviceId: z.string().max(512).nullable().default(null),
      systemDeviceId: z.string().max(512).nullable().default(null),
      /** Optional per-application loopback instead of whole-device loopback. */
      appCapturePid: z.number().int().positive().nullable().default(null),
      appCaptureName: z.string().max(260).nullable().default(null),
      micGain: z.number().min(0).max(8).default(1),
      /** Frames quieter than this are not streamed to STT (saves cost; 0 disables). */
      noiseGateDbfs: z.number().min(-90).max(0).default(-62),
    })
    .prefault({}),
  overlay: z
    .object({
      opacity: z.number().min(0.35).max(1).default(0.98),
      alwaysOnTop: z.boolean().default(true),
      compact: z.boolean().default(false),
      fontScale: z.number().min(0.75).max(1.8).default(1),
      bounds: BoundsSchema.nullable().default(null),
      displayId: z.number().nullable().default(null),
      contentProtection: z.boolean().default(false),
      showTranscript: z.boolean().default(true),
      /** Windows 11 acrylic (frosted glass) behind the overlay; falls back to tinted translucency. */
      glass: z.boolean().default(true),
    })
    .prefault({}),
  hotkeys: z
    .object(
      Object.fromEntries(
        Object.entries(DEFAULT_HOTKEYS).map(([k, v]) => [k, Accelerator.default(v)]),
      ) as Record<HotkeyAction, z.ZodDefault<z.ZodString>>,
    )
    .prefault({}),
  privacy: z
    .object({
      /** Opt-in: transcripts and answers are only kept in memory unless enabled. */
      saveHistory: z.boolean().default(false),
      historyRetentionDays: z.number().int().min(1).max(3650).default(30),
      redactSecrets: z.boolean().default(true),
      includeProfileInPrompts: z.boolean().default(true),
      includeDocumentsInPrompts: z.boolean().default(true),
    })
    .prefault({}),
  budget: z
    .object({
      dailyAnswerLimit: z.number().int().min(1).max(100_000).default(150),
      dailySttMinutesLimit: z.number().int().min(1).max(24 * 60).default(90),
      monthlyUsdCap: z.number().min(0).max(100_000).nullable().default(10),
      /** User-entered prices (USD per 1M tokens) keyed `${provider}:${model}`. No price = cost unknown. */
      prices: z.record(z.string().max(200), PriceSchema).default({}),
    })
    .prefault({}),
  knowledge: z
    .object({
      useEmbeddings: z.boolean().default(false),
      embeddingModel: z.string().max(128).default('gemini-embedding-001'),
      topK: z.number().int().min(1).max(12).default(5),
    })
    .prefault({}),
  appearance: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
    })
    .prefault({}),
  activeProfileId: z.string().max(64).nullable().default(null),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export function defaultSettings(): AppSettings {
  return AppSettingsSchema.parse({});
}

/** Deep-partial patch accepted from the renderer; validated by merging + reparsing in main. */
export const SettingsPatchSchema = z.record(z.string(), z.unknown());
export type SettingsPatch = Record<string, unknown>;
