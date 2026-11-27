import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@doing/contracts';
import { AnswerEngine } from './answer';
import { SessionController } from './session';
import type { WhisperClient } from './streamingTranscriber';
import { joinWords } from './streamingTranscriber';

describe('live pipeline (fake whisper + fake LLM)', () => {
  it('stitches committed text as the final LLM question and bounds windows', async () => {
    const windows: number[] = [];
    const hypotheses = [
      { text: 'How', words: [{ text: 'How', startMs: 0, endMs: 120 }] },
      { text: 'How would you', words: [{ text: 'How', startMs: 0, endMs: 120 }, { text: 'would', startMs: 120, endMs: 240 }, { text: 'you', startMs: 240, endMs: 320 }] },
      { text: 'How would you scale it', words: [{ text: 'How', startMs: 0, endMs: 120 }, { text: 'would', startMs: 120, endMs: 240 }, { text: 'you', startMs: 240, endMs: 320 }, { text: 'scale', startMs: 320, endMs: 400 }, { text: 'it', startMs: 400, endMs: 480 }] },
    ];
    let n = 0;
    const client: WhisperClient = {
      decode: async (req) => {
        windows.push(req.pcm.length / 32);
        const h = hypotheses[Math.min(n++, hypotheses.length - 1)]!;
        return { text: h.text, words: h.words, wordTimestamps: true };
      },
    };
    const s = defaultSettings();
    s.stt.streamingTranscription = true; // the live path is opt-in
    const asked: string[] = [];
    let spec = '';
    const answer = {
      ask: (i: { question: string }) => (asked.push(i.question), 'req'),
      prefetch: (i: { question: string }) => {
        spec = i.question;
        return 'spec-1';
      },
      dropPrefetch: () => {
        spec = '';
      },
      commit: (_id: string, o: { question?: string }) => {
        asked.push(o.question ?? spec);
        return true;
      },
      clearMemory() {},
    } as unknown as AnswerEngine;
    const c = new SessionController({
      audio: { start: async () => undefined, stop: async () => undefined, isRunning: () => true },
      settings: () => s,
      createTranscriber: () => {
        throw new Error('old STT path must not run when whisperClient is set');
      },
      whisperClient: client,
      answer,
      emit: () => undefined,
      history: () => null,
      recordSttSeconds: () => undefined,
      usageToday: () => ({ answers: 0, sttMinutes: 0, costUsd: null }),
      activeProfileName: () => null,
      perf: () => undefined,
      helperInfo: () => ({ running: true, version: 't', error: null }),
      earlyAnswers: () => true,
    });
    await c.start(true);
    const loud = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) loud.writeInt16LE(12000, i * 2);
    for (let i = 0; i < 80; i++) c.onFrame('system', loud);
    expect(windows.every((ms) => ms <= 15_000)).toBe(true);
    expect(joinWords([{ text: 'How', startMs: 0, endMs: 1 }, { text: 'would', startMs: 1, endMs: 2 }, { text: 'you', startMs: 2, endMs: 3 }])).toBe('How would you');
    await c.stop();
  });
});
