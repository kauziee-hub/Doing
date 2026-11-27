/**
 * Optional in-process SAVA (unofficial ONNX of inworld/sava). Official weights are
 * PyTorch-only; this uses matthiastl/sava-onnx (Apache-2.0). If the model or
 * onnxruntime-node is missing, callers get null and the energy VAD takes over.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AudioSource } from '@doing/contracts';
import type { Logger } from '../logger';

const FRAME_SAMPLES = 640;
const STATE_LEN = 798_707;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

export function resolveSavaModelPath(): string | null {
  const name = 'sava-int8.onnx';
  const packaged = join(process.resourcesPath, 'sava', name);
  if (app.isPackaged && existsSync(packaged)) return packaged;
  const repo = join(app.getAppPath(), '..', '..', 'apps', 'desktop', 'resources', 'sava', name);
  const local = join(app.getAppPath(), 'resources', 'sava', name);
  return [process.env.DOING_SAVA_ONNX, packaged, local, repo].find((p) => p && existsSync(p)) ?? null;
}

type Ort = {
  InferenceSession: { create: (p: string, o: object) => Promise<{ run: (f: Record<string, unknown>) => Promise<unknown> }> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};

export class SavaOnnxEngine {
  private session: { run: (feeds: Record<string, unknown>) => Promise<unknown> } | null = null;
  private ort: Ort | null = null;
  private readonly state = new Map<AudioSource, Float32Array>();
  private failed = false;
  ready = false;
  fallbackReason: string | null = null;

  private starting: Promise<boolean> | null = null;

  constructor(private readonly log: Logger) {}

  /** Loads the model once, the first time the live path needs it. */
  ensureStarted(): Promise<boolean> {
    this.starting ??= this.start();
    return this.starting;
  }

  async start(): Promise<boolean> {
    const model = resolveSavaModelPath();
    if (!model) {
      this.fallbackReason = 'SAVA ONNX weights are not installed (see apps/desktop/resources/sava).';
      this.log.warn('sava missing', { reason: this.fallbackReason });
      return false;
    }
    try {
      // Not bundled (native addon): loaded from the app's node_modules at run time.
      this.ort = (await new Function('return import("onnxruntime-node")')()) as Ort;
      this.session = await this.ort.InferenceSession.create(model, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
      });
      this.ready = true;
      this.log.info('sava onnx ready', { model });
      return true;
    } catch (err) {
      this.fallbackReason = `SAVA failed to start (${(err as Error).message}); using energy VAD.`;
      this.log.warn('sava start failed', { error: (err as Error).message });
      this.failed = true;
      return false;
    }
  }

  /**
   * P(speech) (lookahead head: the frame 120 ms back) and P(turn ended) for one 40 ms block.
   * Callers must await each block before sending the next one of the same source: the model's
   * state carries from block to block.
   */
  async score(source: AudioSource, pcm40: Buffer): Promise<{ speech: number; turn: number } | null> {
    if (!this.session || !this.ort || this.failed) return null;
    const pcm = pcm16ToFloat32(pcm40);
    if (pcm.length < FRAME_SAMPLES) return null;
    const frame = pcm.length === FRAME_SAMPLES ? pcm : pcm.subarray(0, FRAME_SAMPLES);
    const state = this.state.get(source) ?? new Float32Array(STATE_LEN);
    try {
      const out = (await this.session.run({
        pcm: new this.ort.Tensor('float32', frame, [1, FRAME_SAMPLES]),
        state: new this.ort.Tensor('float32', state, [1, STATE_LEN]),
      })) as Record<string, { data: Float32Array }>;
      const next = out.new_state?.data;
      // The output tensor is ours: keep it as the next state without copying 3.2 MB per block.
      if (next && next.length === STATE_LEN) this.state.set(source, next);
      const lookahead = out.lookahead?.data[0] ?? out.speech?.data[0] ?? -10;
      const turn0 = out.turn?.data[0] ?? -10;
      return { speech: sigmoid(lookahead), turn: sigmoid(turn0) };
    } catch (err) {
      this.failed = true;
      this.ready = false;
      this.fallbackReason = (err as Error).message;
      this.log.warn('sava infer failed', { error: this.fallbackReason });
      return null;
    }
  }

  /** A new stream for this source (session start): SAVA starts from a zero state. */
  reset(source: AudioSource): void {
    this.state.delete(source);
  }
}
