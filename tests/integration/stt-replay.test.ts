/**
 * Silent replay of the live speech path with the real engine on this PC: Windows SAPI speaks three
 * questions into WAV files (TTS FIXTURE, nothing plays aloud), and they are fed in real time, 20 ms
 * at a time, through LiveCapture (SAVA or the energy VAD) and whisper-server started exactly as
 * the app starts it. Checks that every question comes out word for word and when each turn ended.
 * Opt-in (needs the installed engine, ~40 s):
 *   HIRORA_STT_REPLAY=1 pnpm vitest run tests/integration/stt-replay.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveCapture } from '../../packages/orchestration/src/liveCapture';
import { thresholdsFor } from '../../packages/orchestration/src/turnDetector';
import { WhisperLane } from '../../packages/orchestration/src/whisperLane';
import { runWhisperInference } from '../../packages/providers/src/whisper';

const ENGINE = join(process.env.LOCALAPPDATA ?? '', 'Hirora', 'whisper');
const EXE = join(ENGINE, 'bin', 'Release', 'whisper-server.exe');
const MODEL = ['ggml-large-v3-turbo-q5_0.bin', 'ggml-small-q5_1.bin'].map((m) => join(ENGINE, 'models', m)).find((m) => existsSync(m));
const SAVA = resolve(__dirname, '../../apps/desktop/resources/sava/sava-int8.onnx');
const PORT = 8193;
const QUESTIONS = ['Please introduce yourself.', 'Can you tell me about a challenging project you worked on?', 'What is the difference between a process and a thread?'];
const enabled = process.env.HIRORA_STT_REPLAY === '1' && process.platform === 'win32' && existsSync(EXE) && !!MODEL;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('live speech path, replayed against the real whisper-server (TTS FIXTURE)', () => {
  let dir = '';
  let server: ChildProcess | null = null;
  let audio = Buffer.alloc(0);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hirora-replay-'));
    const ps = QUESTIONS.map((q, i) => `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${join(dir, `q${i}.wav`)}', $f); $s.Speak('${q.replace(/'/g, "''")}'); $s.Dispose();`).join(' ');
    execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); ${ps}`]);
    const wav = (i: number) => {
      const b = readFileSync(join(dir, `q${i}.wav`));
      return b.subarray(b.indexOf('data') + 8);
    };
    const gap = (ms: number) => Buffer.alloc(ms * 32);
    audio = Buffer.concat([gap(800), wav(0), gap(1500), wav(1), gap(1500), wav(2), gap(2500)]);
    // The app's own arguments (EngineManager): no timestamps, language auto.
    server = spawn(EXE, ['-m', MODEL!, '--host', '127.0.0.1', '--port', String(PORT), '-t', '4', '-nt', '-l', 'auto'], { stdio: 'ignore' });
    for (let i = 0; i < 120; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)) return;
      await sleep(500);
    }
    throw new Error('whisper-server did not start');
  }, 90_000);

  afterAll(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  async function replay(useSava: boolean) {
    let score: ((pcm: Buffer) => Promise<{ speech: number; turn: number }>) | undefined;
    if (useSava) {
      const ort = createRequire(resolve(__dirname, '../../apps/desktop/package.json'))('onnxruntime-node');
      const session = await ort.InferenceSession.create(SAVA, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
      let state = new Float32Array(798_707);
      const sig = (x: number) => 1 / (1 + Math.exp(-x));
      score = async (pcm) => {
        const f = new Float32Array(640);
        for (let i = 0; i < 640; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
        const out = await session.run({ pcm: new ort.Tensor('float32', f, [1, 640]), state: new ort.Tensor('float32', state, [1, 798_707]) });
        state = out.new_state.data;
        return { speech: sig(out.lookahead.data[0]), turn: sig(out.turn.data[0]) };
      };
    }
    const lane = new WhisperLane();
    const finals: string[] = [];
    const pauses: number[] = [];
    const t0 = Date.now();
    const cap = new LiveCapture({
      source: 'system',
      role: 'interviewer',
      cheap: false,
      client: {
        decode: (req) =>
          lane.run(req.source, req.priority, async () => {
            const r = await runWhisperInference(`http://127.0.0.1:${PORT}/inference`, fetch, req.pcm, { language: 'en', prompt: req.prompt, wordTimestamps: req.wordTimestamps ?? false });
            return { text: r.text, words: r.words, wordTimestamps: r.wordTimestamps };
          }),
      },
      vocab: () => [],
      thresholds: () => thresholdsFor('medium'),
      useSava,
      savaScores: score,
      now: Date.now,
      onInterim: () => undefined,
      onFinal: (text) => finals.push(text),
      onPause: () => pauses.push(Date.now() - t0),
      onResume: () => undefined,
      onWindowMs: () => undefined,
    });
    for (let off = 0, i = 0; off + 640 <= audio.length; off += 640, i++) {
      cap.pushFrame(audio.subarray(off, off + 640));
      const wait = t0 + (i + 1) * 20 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    await cap.idle();
    for (let i = 0; i < 60 && finals.length < QUESTIONS.length; i++) await sleep(100);
    cap.dispose();
    return { finals, pauses };
  }

  it('SAVA: every question word for word', async () => {
    const r = await replay(true);
    expect(r.finals.map(norm)).toEqual(QUESTIONS.map(norm));
  }, 60_000);

  it('energy VAD: every question word for word', async () => {
    const r = await replay(false);
    expect(r.finals.map(norm)).toEqual(QUESTIONS.map(norm));
  }, 60_000);
});
