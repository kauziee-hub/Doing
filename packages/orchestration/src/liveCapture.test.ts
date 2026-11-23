import { describe, expect, it } from 'vitest';
import { LiveCapture } from './liveCapture';
import { StreamingTranscriber, type HypothesisWord, type WhisperClient, type WhisperDecodeRequest } from './streamingTranscriber';
import { thresholdsFor } from './turnDetector';
import { WhisperLane } from './whisperLane';

const FRAME_BYTES = 640; // 20 ms of 16 kHz PCM16
const frame = (amp: number): Buffer => {
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const words = (...list: Array<[string, number, number]>): HypothesisWord[] => list.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

/** 200 ms quiet, 1 s loud, then quiet: returns what reached Whisper and the turn events. */
async function runCapture(opts: { sava?: (pcm: Buffer) => Promise<{ speech: number; turn: number } | null> }) {
  let now = 10_000;
  const decodes: WhisperDecodeRequest[] = [];
  const client: WhisperClient = {
    decode: async (req) => {
      decodes.push(req);
      return { text: 'hello there', words: words(['hello', 300, 700], ['there', 700, 1100]), wordTimestamps: true };
    },
  };
  const finals: string[] = [];
  const pauses: number[] = [];
  const cap = new LiveCapture({
    source: 'system',
    role: 'interviewer',
    cheap: true, // no interim ticks: the end-of-turn decode sees everything
    client,
    vocab: () => [],
    thresholds: () => thresholdsFor('medium'),
    useSava: !!opts.sava,
    savaScores: opts.sava,
    now: () => now,
    onInterim: () => undefined,
    onFinal: (text) => finals.push(text),
    onPause: (at) => pauses.push(at),
    onResume: () => undefined,
    onWindowMs: () => undefined,
  });
  let pauseFrame = -1;
  const lastLoudAt = 10_000 + 59 * 20;
  for (let i = 0; i < 100; i++) {
    cap.pushFrame(frame(i >= 10 && i < 60 ? 12_000 : 0));
    if (opts.sava) await cap.idle();
    if (pauses.length && pauseFrame < 0) pauseFrame = i;
    now += 20;
  }
  await cap.idle();
  for (let i = 0; i < 50 && !finals.length; i++) await sleep(5);
  return { decodes, finals, pauses, pauseFrame, lastLoudAt };
}

describe('LiveCapture', () => {
  it('energy fallback: every 20 ms frame of the turn reaches Whisper, pre-roll included', async () => {
    const r = await runCapture({});
    expect(r.finals).toEqual(['hello there']);
    expect(r.pauseFrame).toBeGreaterThan(60);
    // Everything from the first frame (the quiet lead-in is in the 500 ms pre-roll) to the pause.
    const windowMs = r.decodes[0]!.pcm.length / 32;
    expect(windowMs).toBe((r.pauseFrame + 1) * 20);
    // About 0.3 s after the voice stopped, like 0.3.1, and the pause mark is the last loud frame.
    expect((r.pauseFrame - 59) * 20).toBeGreaterThanOrEqual(260);
    expect((r.pauseFrame - 59) * 20).toBeLessThanOrEqual(340);
    expect(r.pauses[0]).toBe(r.lastLoudAt);
  });

  it('SAVA: blocks are scored one at a time, in order, and no audio is dropped', async () => {
    let pending = 0;
    let maxPending = 0;
    const calls: number[] = [];
    const sava = async (pcm: Buffer) => {
      pending++;
      maxPending = Math.max(maxPending, pending);
      calls.push(pcm.length);
      await sleep(1);
      pending--;
      const loud = Math.abs(pcm.readInt16LE(2)) > 1000;
      return { speech: loud ? 0.98 : 0.02, turn: loud ? 0.02 : 0.95 };
    };
    const r = await runCapture({ sava });
    expect(maxPending).toBe(1);
    expect(calls.every((n) => n === 1280)).toBe(true);
    expect(r.finals).toEqual(['hello there']);
    const windowMs = r.decodes[0]!.pcm.length / 32;
    // The whole loud second plus its lead-in reached Whisper (with the 20 ms frame bug only ~half did).
    expect(windowMs).toBeGreaterThanOrEqual(1000 + 200);
    expect(windowMs).toBeLessThanOrEqual((r.pauseFrame + 1) * 20);
  });
});

describe('LiveCapture: start and end of a turn', () => {
  it('starts the turn when the voice is loud even if SAVA is slow to call it speech (first word kept)', async () => {
    let block = 0;
    // As measured live on the first question: SAVA says "not speech" for ~0.75 s of clear speech.
    const sava = async (pcm: Buffer) => {
      const loud = Math.abs(pcm.readInt16LE(2)) > 1000;
      if (loud) block++;
      return { speech: loud && block > 18 ? 0.98 : 0.02, turn: loud ? 0.02 : 0.95 };
    };
    const r = await runCapture({ sava });
    expect(r.finals).toEqual(['hello there']);
    // Loud from frame 10 (200 ms): the decoded audio starts before it, so the first word is in.
    const windowMs = r.decodes[0]!.pcm.length / 32;
    expect(windowMs).toBeGreaterThanOrEqual((r.pauseFrame + 1) * 20 - 200);
  });

  it('decodes as soon as the speaker goes quiet and uses that as the final text (no decode after the turn ends)', async () => {
    let now = 50_000;
    const decodes: Array<{ priority: string; at: number }> = [];
    const timings: string[] = [];
    const finals: string[] = [];
    const cap = new LiveCapture({
      source: 'system',
      role: 'interviewer',
      cheap: false,
      client: {
        decode: async (req) => {
          decodes.push({ priority: req.priority, at: now });
          return { text: ' What is a thread?', words: [], wordTimestamps: false };
        },
      },
      vocab: () => [],
      thresholds: () => thresholdsFor('medium'),
      useSava: false,
      now: () => now,
      onInterim: () => undefined,
      onFinal: (text) => finals.push(text),
      onPause: () => undefined,
      onResume: () => undefined,
      onWindowMs: () => undefined,
      onTiming: (e) => timings.push(`${e.stage}:${e.label}`),
    });
    for (let i = 0; i < 80; i++) {
      cap.pushFrame(frame(i >= 10 && i < 60 ? 12_000 : 0));
      await sleep(0);
      now += 20;
    }
    for (let i = 0; i < 50 && !finals.length; i++) await sleep(5);
    expect(finals).toEqual(['What is a thread?']);
    // A decode started 60 ms after the last loud frame (frame 59), before the turn ended, and it is
    // the final text: no decode ran at the end of the turn. (Periodic ticks may also have run.)
    expect(decodes.some((d) => d.at - (50_000 + 59 * 20) === 60)).toBe(true);
    expect(decodes.some((d) => d.priority === 'final')).toBe(false);
    expect(timings).toContain('stt_decode:system:final-reused');
  });
});

describe('StreamingTranscriber end of turn', () => {
  const setup = (decode: WhisperClient['decode']) => {
    const finals: string[] = [];
    const t = new StreamingTranscriber('system', { decode }, { interim() {}, committedAdvanced() {}, final: (e) => finals.push(e.text), windowMs() {} }, () => ({ vocab: [], committedHint: '' }));
    t.resetUtterance();
    t.setSpeechActive(true);
    t.pushPcm(Buffer.alloc(32 * 1500), 0);
    return { t, finals };
  };

  it('waits for a tick still in flight, then decodes the tail: the last word is kept', async () => {
    let n = 0;
    const { t, finals } = setup(async (req) => {
      n++;
      if (req.priority !== 'final') {
        await sleep(30);
        return { text: 'what is a', words: words(['what', 0, 300], ['is', 300, 500], ['a', 500, 600]), wordTimestamps: true };
      }
      return { text: 'what is a thread', words: words(['what', 0, 300], ['is', 300, 500], ['a', 500, 600], ['thread', 600, 1100]), wordTimestamps: true };
    });
    void t.tick();
    await t.finalize();
    expect(n).toBe(2);
    expect(finals).toEqual(['what is a thread']);
  });

  it('keeps what the last tick heard when the end-of-turn decode fails', async () => {
    const { t, finals } = setup(async (req) =>
      req.priority === 'final' ? null : { text: 'what is a thread', words: words(['what', 0, 300], ['is', 300, 500], ['a', 500, 600], ['thread', 600, 1100]), wordTimestamps: true },
    );
    await t.tick();
    await t.finalize();
    expect(finals).toEqual(['what is a thread']);
  });

  it('the final text is one more decode of the whole turn, not the stitched live text', async () => {
    const reqs: WhisperDecodeRequest[] = [];
    const { t, finals } = setup(async (req) => {
      reqs.push(req);
      // Live decodes misheard the end; the end-of-turn decode of the whole turn gets it right.
      if (req.priority === 'final') return { text: ' What is the difference between a process and a thread?', words: [], wordTimestamps: false };
      return { text: ' What is the difference between the process and', words: [], wordTimestamps: false };
    });
    await t.tick();
    await t.tick();
    expect(t.committedText).toBe('What is the difference between the process and');
    await t.finalize();
    const last = reqs[reqs.length - 1]!;
    expect(last.priority).toBe('final');
    expect(last.pcm.length / 32).toBe(1500); // the whole turn
    expect(reqs.every((r) => r.windowStartMs === 0 && r.wordTimestamps === false)).toBe(true);
    expect(finals).toEqual(['What is the difference between a process and a thread?']);
  });
});

describe('WhisperLane', () => {
  it('skips a tick while its source is busy but queues the end-of-turn decode', async () => {
    const lane = new WhisperLane();
    const order: string[] = [];
    const slow = lane.run('system', 'high', async () => {
      await sleep(20);
      order.push('tick');
      return 'tick';
    });
    expect(await lane.run('system', 'high', async () => 'skipped?')).toBeNull();
    expect(await lane.run('mic', 'low', async () => 'mic tick')).toBeNull();
    const final = lane.run('system', 'final', async () => {
      order.push('final');
      return 'final';
    });
    expect(await final).toBe('final');
    expect(await slow).toBe('tick');
    expect(order).toEqual(['tick', 'final']);
  });
});
