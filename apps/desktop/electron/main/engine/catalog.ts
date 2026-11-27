import type { EngineTier } from '@doing/contracts';

/**
 * Everything Doing downloads on first run, pinned to exact files. SHA-256 values come
 * from the publishers (GitHub release asset digests, Hugging Face LFS ids), checked
 * 2026-11-22. Ollama models are fetched by Ollama itself, which verifies their digests.
 */
export interface PinnedFile {
  url: string;
  sha256: string;
  bytes: number;
  /** File name on disk. */
  file: string;
}

export interface TierCatalog {
  speechRuntime: PinnedFile & { label: string; /** folder under whisper/ */ dir: string; /** a file only this build has */ marker: string };
  speechModel: PinnedFile & { label: string };
  /** `vision`: the model reads screenshots. */
  answerModel: { tag: string; label: string; bytes: number; vision: boolean };
  /** How often live text is refreshed while someone speaks. */
  interimEveryMs: number;
  whisperThreads: number;
  /**
   * Tokens per answer slot (Ollama's OLLAMA_CONTEXT_LENGTH). The prompt alone reaches ~4,000
   * tokens with a full résumé, so at 4K the answer got as few as 67 tokens and stopped
   * mid-sentence (measured 2026-11-26). 8K on the GPU costs 256 MiB more for the two slots.
   */
  answerContext: number;
}

const WHISPER = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454';
const WHISPER_MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const ANSWER_RUNTIME: PinnedFile & { label: string; version: string } = {
  label: 'Ollama 0.40.16 runtime',
  version: '0.40.16',
  url: 'https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-windows-amd64.zip',
  sha256: '50fcf5ad54277f2fa5d173ebfc93bcb017adbc0c9ef2314daabc96ca9e6aa64e',
  bytes: 1_618_244_995,
  file: 'ollama-windows-amd64.zip',
};

export const CATALOG: Record<EngineTier, TierCatalog> = {
  gpu: {
    speechRuntime: {
      label: 'whisper.cpp b5454 · NVIDIA CUDA 12.4',
      url: `${WHISPER}/whisper-bin-win-cuda-12.4.0-x64.zip`,
      sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
      bytes: 684_913_404,
      file: 'whisper-bin-win-cuda-12.4.0-x64.zip',
      dir: 'bin',
      marker: 'ggml-cuda.dll',
    },
    speechModel: {
      label: 'Whisper large-v3-turbo (q5_0)',
      url: `${WHISPER_MODELS}/ggml-large-v3-turbo-q5_0.bin`,
      sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      bytes: 574_041_195,
      file: 'ggml-large-v3-turbo-q5_0.bin',
    },
    answerModel: { tag: 'qwen3.5:4b', label: 'Qwen 3.5 4B', bytes: 3_324_173_934, vision: true },
    interimEveryMs: 350,
    whisperThreads: 4,
    answerContext: 8192,
  },
  cpu: {
    speechRuntime: {
      label: 'whisper.cpp b5454 · CPU',
      url: `${WHISPER}/whisper-bin-x64.zip`,
      sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
      bytes: 8_928_640,
      file: 'whisper-bin-x64.zip',
      dir: 'cpu-bin',
      marker: 'whisper-server.exe',
    },
    // Not base: on the CPU it misheard "thread" as "threat" in the spoken test (2026-11-22).
    speechModel: {
      label: 'Whisper small (q5_1)',
      url: `${WHISPER_MODELS}/ggml-small-q5_1.bin`,
      sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
      bytes: 190_085_487,
      file: 'ggml-small-q5_1.bin',
    },
    // Not qwen3.5:2b: Qwen 3.5 is a hybrid (recurrent) model, so llama.cpp re-reads the whole
    // prompt for every question (4.1–4.5 s on a CPU). qwen3:1.7b reuses the cached instructions:
    // 0.16–0.18 s to the first token after the first question (measured 2026-11-22, CPU only).
    answerModel: { tag: 'qwen3:1.7b', label: 'Qwen 3 1.7B', bytes: 1_359_292_957, vision: false },
    interimEveryMs: 700,
    whisperThreads: 0, // 0 = half the logical processors, decided at start
    // Lean prompts on the CPU tier; 8K would hold ~1 GB more RAM for the two slots.
    answerContext: 4096,
  },
};

/** NVIDIA cards with at least this much memory fit large Whisper + the 4B model together. */
export const GPU_TIER_MIN_VRAM_MB = 5800;

export function resolveTier(setting: 'auto' | EngineTier, gpu: { vramMb: number } | null): EngineTier {
  if (setting !== 'auto') return setting;
  return gpu && gpu.vramMb >= GPU_TIER_MIN_VRAM_MB ? 'gpu' : 'cpu';
}
