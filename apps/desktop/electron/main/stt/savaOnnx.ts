/**
 * Optional in-process SAVA (unofficial ONNX of inworld/sava). Official weights are
 * PyTorch-only; this uses matthiastl/sava-onnx (Apache-2.0). If the model or
 * onnxruntime-node is missing, callers get null and the energy VAD takes over.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AudioSource } from '@hirora/contracts';
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
  return [process.env.HIRORA_SAVA_ONNX, packaged, local, repo].find((p) => p && existsSync(p)) ?? null;
}

export class SavaOnnxEngine {
  private session: { run: (feeds: Record<string, unknown>) => Promise<unknown> } | null = null;
  private readonly state = new Map<AudioSource, Float32Array>();
  private failed = false;
  ready = false;
  fallbackReason: string | null = null;

  constructor(private readonly log: Logger) {}

  async start(): Promise<boolean> {
    const model = resolveSavaModelPath();
    if (!model) {
      this.fallbackReason = 'SAVA ONNX weights are not installed (see apps/desktop/resources/sava).';
      this.log.warn('sava missing', { reason: this.fallbackReason });
      return false;
    }
    try {
      const ort = (await new Function('return import("onnxruntime-node")')()) as {
        InferenceSession: { create: (p: string, o: object) => Promise<{ run: (f: Record<string, unknown>) => Promise<unknown> }> };
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      };
      this.session = await ort.InferenceSession.create(model, {
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

  scores(source: AudioSource, pcm40: Buffer): { speech: number; turn: number } | null {
    if (!this.session || this.failed) return null;
    const pcm = pcm16ToFloat32(pcm40);
    if (pcm.length < FRAME_SAMPLES) return null;
    const frame = pcm.length === FRAME_SAMPLES ? pcm : pcm.subarray(0, FRAME_SAMPLES);
    let state = this.state.get(source);
    if (!state) {
      state = new Float32Array(STATE_LEN);
      this.state.set(source, state);
    }
    // Inference is async; we keep a fire-and-forget cache for the last result.
    const cached = this.last.get(source) ?? { speech: 0, turn: 0 };
    void this.step(source, frame, state);
    return cached;
  }

  private last = new Map<AudioSource, { speech: number; turn: number }>();

  private async step(source: AudioSource, frame: Float32Array, state: Float32Array): Promise<void> {
    if (!this.session) return;
    try {
      const ort = (await new Function('return import("onnxruntime-node")')()) as {
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      };
      const feeds = {
        pcm: new ort.Tensor('float32', frame, [1, FRAME_SAMPLES]),
        state: new ort.Tensor('float32', state, [1, STATE_LEN]),
      };
      const out = (await this.session.run(feeds)) as unknown as Record<string, { data: Float32Array }>;
      const lookahead = out.lookahead?.data[0] ?? out.speech?.data[0] ?? -10;
      const turn0 = out.turn?.data[0] ?? -10;
      const next = out.new_state?.data;
      if (next && next.length === STATE_LEN) this.state.set(source, new Float32Array(next));
      this.last.set(source, { speech: sigmoid(lookahead), turn: sigmoid(turn0) });
    } catch (err) {
      this.failed = true;
      this.ready = false;
      this.fallbackReason = (err as Error).message;
      this.log.warn('sava infer failed', { error: this.fallbackReason });
    }
  }

  reset(source: AudioSource): void {
    this.state.delete(source);
    this.last.delete(source);
  }
}
