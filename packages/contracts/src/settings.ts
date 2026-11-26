import { z } from 'zod';

/**
 * Hirora runs one engine, entirely on this PC (ADR 0012): whisper.cpp for live
 * transcription and an Ollama runtime that Hirora installs and manages for answers.
 * The ids below name those two pieces inside the app; users never pick a provider.
 */
export const PROVIDER_IDS = ['ollama'] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
/** The answer engine (Hirora's own Ollama runtime on loopback). */
export const LOCAL_ENGINE: ProviderId = 'ollama';

/** `audio.systemDeviceId` value meaning "every output device, mixed". */
export const SYSTEM_ALL_OUTPUTS = 'all';
/** Hirora's private Ollama server. A separate port from a user's own Ollama (11434), so the two never collide. */
export const ENGINE_OLLAMA_PORT = 11435;
export const ENGINE_OLLAMA_URL = `http://127.0.0.1:${ENGINE_OLLAMA_PORT}/v1`;
/** whisper.cpp server started by Hirora (loopback only). */
export const ENGINE_WHISPER_URL = 'http://127.0.0.1:8178';

export const STT_PROVIDER_IDS = ['local-whisper'] as const;
export const SttProviderIdSchema = z.enum(STT_PROVIDER_IDS);
export type SttProviderId = z.infer<typeof SttProviderIdSchema>;

/** `gpu`: NVIDIA GPU with enough memory (large Whisper + 4B model). `cpu`: smaller models on the processor. */
export const ENGINE_TIERS = ['gpu', 'cpu'] as const;
export const EngineTierSchema = z.enum(ENGINE_TIERS);
export type EngineTier = z.infer<typeof EngineTierSchema>;

export const AUDIO_SOURCES = ['mic', 'system', 'app'] as const;
export const AudioSourceSchema = z.enum(AUDIO_SOURCES);
export type AudioSource = z.infer<typeof AudioSourceSchema>;

/**
 * Since 0.3.1 there is one mode, `assistant`: it works out what each request needs. The older
 * values stay valid only so saved history and profiles keep loading.
 */
export const MODES = [
  'assistant',
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
  assistant: 'Assistant',
  interview_practice: 'Interview Practice',
  live_copilot: 'Live Authorised Copilot',
  coding: 'Coding',
  explain: 'Explain / Teach',
  general: 'General Q&A',
  meeting_notes: 'Meeting Notes',
};

export const MODE_SHORT_LABELS: Record<Mode, string> = {
  assistant: 'Assistant',
  interview_practice: 'Practice',
  live_copilot: 'Copilot',
  coding: 'Coding',
  explain: 'Explain',
  general: 'Q&A',
  meeting_notes: 'Notes',
};

const Accelerator = z.string().max(64);

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
  screenContext: 'Answer from the screen',
};

export const BoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(240).max(8000),
  height: z.number().int().min(120).max(8000),
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const AppSettingsSchema = z.object({
  /** 2 = local-only engine (0.3.0). Older files load leniently: removed sections are dropped. */
  schemaVersion: z.literal(2).default(2),
  onboardingComplete: z.boolean().default(false),
  engine: z
    .object({
      /** `auto` picks `gpu` on an NVIDIA GPU with ≥ 6 GB, otherwise `cpu`. */
      tier: z.enum(['auto', ...ENGINE_TIERS]).default('auto'),
    })
    .prefault({}),
  answer: z
    .object({
      /** Always `assistant` (one mode does everything); older saved values are read as it. */
      mode: z.literal('assistant').catch('assistant').default('assistant'),
      /**
       * Look at the screen with a question: `auto` when the question refers to something shown
       * ("this code", "what's on the slide"), `always`, or `off`. Needs a model that reads images.
       */
      screen: z.enum(['auto', 'always', 'off']).default('auto'),
      length: z.enum(['short', 'medium', 'long']).default('medium'),
      tone: z.string().max(200).default('confident, warm, concise'),
      format: z.enum(['talking_points', 'paragraph', 'star']).default('paragraph'),
      language: z.string().max(40).default('English'),
      technicalDepth: z.enum(['basic', 'intermediate', 'expert']).default('intermediate'),
      codingIncludeTests: z.boolean().default(true),
      autoAnswer: z.boolean().default(true),
      /** Which captured source may auto-trigger answers. The app never knows who is speaking. */
      autoAnswerSources: z.array(AudioSourceSchema).default(['system', 'app']),
      /** A cold model load on the CPU tier can take this long; answers usually start in under a second. */
      firstTokenTimeoutMs: z.number().int().min(1500).max(120_000).default(30_000),
      totalTimeoutMs: z.number().int().min(5000).max(300_000).default(120_000),
      maxOutputTokens: z.number().int().min(64).max(8192).default(900),
      deepMaxOutputTokens: z.number().int().min(256).max(32_768).default(2500),
      temperature: z.number().min(0).max(2).default(0.4),
      memoryTurns: z.number().int().min(0).max(12).default(4),
    })
    .prefault({}),
  stt: z
    .object({
      /** Whisper language code (e.g. en, hi). Empty string = automatic detection. */
      language: z.string().max(20).default(''),
      customVocabulary: z.array(z.string().max(50)).max(100).default([]),
      /**
       * Live path with SAVA end-of-turn and LocalAgreement text (LiveCapture). Off by default until
       * it is faster than the 0.3.1 path in live tests (docs/STT_STREAMING.md).
       */
      streamingTranscription: z.boolean().default(false),
      /** SAVA end-of-turn; `energy` is the previous VAD + 300 ms pause. */
      sttTurnDetector: z.enum(['sava', 'energy']).default('sava'),
      /** `single-mic`: one mic for everyone in the room, so mic turns are answered too and not labelled as yours. */
      captureMode: z.enum(['two-stream', 'single-mic']).default('two-stream'),
      /** Optional high-beam full-utterance decode for saved history only (never the live answer). */
      highBeamHistory: z.boolean().default(false),
      savaAggressiveness: z.enum(['low', 'medium', 'high']).default('medium'),
      speechOnThreshold: z.number().min(0).max(1).default(0.5),
      turnThreshold: z.number().min(0).max(1).default(0.5),
      turnHoldFrames: z.number().int().min(1).max(8).default(2),
      maxSilenceMs: z.number().int().min(200).max(4000).default(1200),
      savaMinEnergyDbfs: z.number().min(-90).max(0).default(-50),
    })
    .prefault({}),
  audio: z
    .object({
      micEnabled: z.boolean().default(true),
      systemEnabled: z.boolean().default(true),
      micDeviceId: z.string().max(512).nullable().default(null),
      /**
       * Output to capture. SYSTEM_ALL_OUTPUTS mixes every speaker/headphone endpoint (default:
       * survives Bluetooth headsets switching to hands-free and call apps on another device);
       * null follows the Windows default; anything else is one endpoint id.
       */
      systemDeviceId: z.string().max(512).nullable().default('all'),
      /** Optional per-application loopback instead of whole-device loopback. */
      appCapturePid: z.number().int().positive().nullable().default(null),
      appCaptureName: z.string().max(260).nullable().default(null),
      micGain: z.number().min(0).max(8).default(1),
      /** Frames quieter than this are not transcribed (0 disables). */
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
      /** Ask Windows to leave the overlay out of screen captures/shares. On by default since 0.2.1 (ADR 0008). */
      contentProtection: z.boolean().default(true),
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
  knowledge: z
    .object({
      topK: z.number().int().min(1).max(12).default(5),
    })
    .prefault({}),
  appearance: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
    })
    .prefault({}),
  updates: z
    .object({
      /** Ask GitHub once a day whether a newer Hirora is out, and say so (it never installs on its own). */
      checkAutomatically: z.boolean().default(true),
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
