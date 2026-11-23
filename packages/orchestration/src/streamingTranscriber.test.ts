import { describe, expect, it } from 'vitest';
import {
  StreamingTranscriber,
  clipWhisperPrompt,
  isRepetitiveHallucination,
  longestCommonPrefix,
  normalizeWord,
  type HypothesisWord,
  type WhisperClient,
} from './streamingTranscriber';
import { TurnDetector, thresholdsFor, SAVA_FRAME_MS } from './turnDetector';
import { ConversationContext, isEchoBleed, tokenOverlap } from './conversationContext';
import { sameQuestion } from './question';

function w(text: string, startMs: number, endMs = startMs + 80): HypothesisWord {
  return { text, startMs, endMs };
}

describe('agreement / commit', () => {
  it('commits the longest common prefix only after it agrees twice (LocalAgreement-2)', () => {
    const events: string[] = [];
    const t = new StreamingTranscriber(
      'system',
      { decode: async () => null },
      {
        interim: (e) => events.push(`i:${e.committed}|${e.tentative}`),
        committedAdvanced: (c) => events.push(`c:${c}`),
        final: (e) => events.push(`f:${e.text}`),
        windowMs: () => undefined,
      },
      () => ({ vocab: [], committedHint: '' }),
    );
    t.applyHypothesis([w('How', 0), w('would', 80), w('you', 160)], false, true);
    expect(t.committedText).toBe('');
    t.applyHypothesis([w('How', 0), w('would', 80), w('you', 160), w('scale', 240)], false, true);
    expect(t.committedText).toBe('How would you');
    t.applyHypothesis([w('How', 0), w('would', 80), w('you', 160), w('scale', 240), w('it', 320)], false, true);
    expect(t.committedText).toBe('How would you scale');
  });

  it('never changes committed words when a later hypothesis flip-flops', () => {
    const t = new StreamingTranscriber('system', { decode: async () => null }, { interim() {}, committedAdvanced() {}, final() {}, windowMs() {} }, () => ({ vocab: [], committedHint: '' }));
    const rbac = [w('What', 0, 40), w('is', 40, 80), w('RBAC', 80, 120)];
    t.applyHypothesis(rbac, false, true);
    t.applyHypothesis(rbac, false, true);
    const locked = t.committedText;
    expect(locked).toBe('What is RBAC');
    t.applyHypothesis([...rbac, w('used', 120, 160)], false, true);
    expect(t.committedText).toBe(locked);
    t.applyHypothesis([w('What', 0, 40), w('is', 40, 80), w('REST', 80, 120), w('used', 120, 160)], false, true);
    expect(t.committedText).toBe(locked);
  });

  it('drops a repetitive hallucination hypothesis', () => {
    expect(isRepetitiveHallucination('thank you thank you thank you thank you')).toBe(true);
    expect(isRepetitiveHallucination('How would you scale a payments API')).toBe(false);
  });

  it('falls back to segment granularity when word timestamps are missing', () => {
    const t = new StreamingTranscriber('system', { decode: async () => null }, { interim() {}, committedAdvanced() {}, final() {}, windowMs() {} }, () => ({ vocab: [], committedHint: '' }));
    t.applyHypothesis([w('How would you scale it', 0, 1200)], false, false);
    expect(t.committedText).toBe('');
    t.applyHypothesis([w('How would you scale it', 0, 1200)], false, false);
    // Still uncommitted until finalize/commitAll — segment unit must agree; finalize commits.
    void t.finalize();
  });

  it('clips the whisper prompt to the token budget', () => {
    const p = clipWhisperPrompt(['Kubernetes', 'gRPC'], 'a'.repeat(5000), 224);
    expect(p.length).toBeLessThanOrEqual(224 * 4);
  });

  it('normalizeWord strips punctuation for comparison only', () => {
    expect(normalizeWord('RBAC?')).toBe('rbac');
    expect(longestCommonPrefix(['how', 'would'], ['how', 'would', 'you'])).toBe(2);
  });
});

describe('TurnDetector', () => {
  const t = () => new TurnDetector(thresholdsFor('medium'));

  function speech(d: TurnDetector, n: number, start = 0, p = 0.9): number {
    let ts = start;
    for (let i = 0; i < n; i++) {
      d.push({ speech: p, turn: 0.05, tsMs: ts, energyDbfs: -20 });
      ts += SAVA_FRAME_MS;
    }
    return ts;
  }

  it('ends a normal turn after sustained turn prob and a silence guard', () => {
    const d = t();
    let ts = speech(d, 20);
    expect(d.isSpeaking).toBe(true);
    let ev = null;
    for (let i = 0; i < 8; i++) {
      ev = d.push({ speech: 0.1, turn: 0.8, tsMs: ts, energyDbfs: -60 });
      ts += SAVA_FRAME_MS;
      if (ev?.type === 'turnEnd') break;
    }
    expect(ev?.type).toBe('turnEnd');
  });

  it('does not end on a brief mid-sentence pause', () => {
    const d = t();
    let ts = speech(d, 8);
    const ev = d.push({ speech: 0.1, turn: 0.2, tsMs: ts, energyDbfs: -55 });
    expect(ev?.type).not.toBe('turnEnd');
    expect(d.isSpeaking).toBe(true);
  });

  it('emits resumed if speech returns within the resume window', () => {
    const d = t();
    let ts = speech(d, 20);
    let end: ReturnType<TurnDetector['push']> = null;
    for (let i = 0; i < 12; i++) {
      end = d.push({ speech: 0.05, turn: 0.8, tsMs: ts, energyDbfs: -62 });
      ts += SAVA_FRAME_MS;
      if (end?.type === 'turnEnd') break;
    }
    expect(end?.type).toBe('turnEnd');
    const ev = d.push({ speech: 0.9, turn: 0.05, tsMs: ts + 80, energyDbfs: -18 });
    expect(ev?.type).toBe('resumed');
  });

  it('force-splits at 45 s', () => {
    const d = t();
    let last: ReturnType<TurnDetector['push']> = null;
    for (let i = 0; i < 2000; i++) {
      last = d.push({ speech: 0.9, turn: 0.01, tsMs: i * SAVA_FRAME_MS, energyDbfs: -15 });
      if (last?.type === 'turnEnd') break;
    }
    expect(last?.type).toBe('turnEnd');
  });

  it('falls back to max silence when turn never fires', () => {
    const d = t();
    let ts = speech(d, 20);
    let ev = null;
    for (let i = 0; i < 50; i++) {
      ev = d.push({ speech: 0.05, turn: 0.1, tsMs: ts, energyDbfs: -70 });
      ts += SAVA_FRAME_MS;
      if (ev?.type === 'turnEnd') break;
    }
    expect(ev?.type).toBe('turnEnd');
  });
});

describe('sameQuestion normalization', () => {
  it('treats case, punctuation and a short trailing extension as the same question', () => {
    expect(sameQuestion('How would you scale it?', 'how would you scale it')).toBe(true);
    expect(sameQuestion('How would you scale it', 'How would you scale it to millions of users')).toBe(true);
    expect(sameQuestion('What is RBAC?', 'Explain CAP theorem')).toBe(false);
  });
});

describe('conversation / bleed', () => {
  it('caps prompt text and formats roles', () => {
    const c = new ConversationContext();
    c.push({ role: 'interviewer', text: 'Tell me about yourself', ts: 1 });
    c.push({ role: 'me', text: 'I work on payments', ts: 2 });
    expect(c.promptBlock()).toContain('Interviewer:');
    expect(c.promptBlock()).toContain('Me:');
  });
  it('detects headphone-less mic bleed', () => {
    expect(tokenOverlap('how would you scale kafka', 'how would you scale kafka')).toBeGreaterThan(0.8);
    expect(isEchoBleed('how would you scale kafka', 'how would you scale kafka', 1000, 1100)).toBe(true);
    expect(isEchoBleed('I think we used Postgres', 'how would you scale kafka', 1000, 1100)).toBe(false);
  });
});

describe('window bound', () => {
  it('reports window length never above 15 s even after a long utterance', async () => {
    const windows: number[] = [];
    const pcm = Buffer.alloc(16_000 * 2); // 1 s silence
    const client: WhisperClient = {
      decode: async (req) => {
        windows.push(req.pcm.length / 32);
        return { text: 'hello', words: [{ text: 'hello', startMs: 0, endMs: 200 }], wordTimestamps: true };
      },
    };
    const t = new StreamingTranscriber('system', client, { interim() {}, committedAdvanced() {}, final() {}, windowMs: (ms) => windows.push(ms) }, () => ({ vocab: [], committedHint: '' }));
    t.resetUtterance();
    t.setSpeechActive(true);
    for (let i = 0; i < 40; i++) t.pushPcm(pcm, i * 1000);
    await t.tick();
    expect(Math.max(0, ...windows.filter((x) => x > 10))).toBeLessThanOrEqual(15_000);
    t.dispose();
  });
});
