/**
 * FIXTURE test: a local HTTP server stands in for whisper.cpp's server (GET / and
 * POST /inference) so utterance buffering, WAV encoding and response filtering can
 * be checked offline. The real server is measured in tools/interview-check.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalWhisperTranscriber, parseWhisperResponse, pcmToWav, stripAnnotations, whisperText } from './whisper';

let server: Server;
let base = '';
const uploads: Array<{ bytes: number; language: string | null; prompt: string | null }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('whisper.cpp server');
        return;
      }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const file = form.get('file') as Blob;
      uploads.push({ bytes: file.size, language: form.get('language') as string | null, prompt: form.get('prompt') as string | null });
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          text: 'How would you scale it? Thanks for watching!',
          segments: [
            { text: ' How would you scale it?', no_speech_prob: 0.02 },
            { text: ' Thanks for watching!', no_speech_prob: 0.93 },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const frame = (amp: number) => {
  const b = Buffer.alloc(3200); // 100 ms
  for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i / 4) * amp), i * 2);
  return b;
};

describe('LocalWhisperTranscriber (fixture whisper.cpp server)', () => {
  it('builds a valid 16 kHz mono WAV header and cleans Whisper output', () => {
    const wav = pcmToWav(Buffer.alloc(320));
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(320);
    expect(whisperText({ text: 'fallback' })).toBe('fallback');
    expect(stripAnnotations('[BLANK_AUDIO] So (music) tell me')).toBe('So tell me');
    // whisper-server started with -nt lists words but with null times: fall back, drop nothing.
    const noTimes = parseWhisperResponse({
      text: ' What is a thread?',
      segments: [{ text: ' What is a thread?', words: [{ word: ' What', start: null, end: null }, { word: ' thread?', start: null, end: null }] }],
    });
    expect(noTimes.wordTimestamps).toBe(false);
    expect(noTimes.text).toBe('What is a thread?');
    expect(noTimes.words).toEqual([]);
    const parsed = parseWhisperResponse({
      text: 'How would you',
      segments: [
        {
          text: ' How would you',
          no_speech_prob: 0.01,
          words: [
            { word: ' How', start: 0.1, end: 0.2 },
            { word: ' would', start: 0.2, end: 0.35 },
            { word: ' you', start: 0.35, end: 0.5 },
          ],
        },
      ],
    });
    expect(parsed.wordTimestamps).toBe(true);
    expect(parsed.words.map((w) => w.text)).toEqual(['How', 'would', 'you']);
  });

  it('transcribes an utterance when the speaker stops, drops no-speech segments, never sends silence', async () => {
    const events: string[] = [];
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    // Live text off (huge interval) so the request count is deterministic.
    const stt = new LocalWhisperTranscriber(base, fetch, 60_000);
    const s = await stt.open(
      { language: 'en-IN', vocabulary: ['Kafka'] },
      {
        onInterim: (t) => events.push(`i:${t}`),
        onFinalSegment: (t) => events.push(`f:${t}`),
        onUtteranceEnd: () => {
          events.push('end');
          ended();
        },
        onError: (e) => events.push(`err:${e.code}`),
        onClose: () => events.push('closed'),
      },
    );
    // Pure silence + endOfSpeech: nothing must be uploaded.
    for (let i = 0; i < 5; i++) s.sendAudio(frame(5));
    s.endOfSpeech();
    await new Promise((r) => setTimeout(r, 300));
    expect(uploads.length).toBe(0);
    for (let i = 0; i < 10; i++) s.sendAudio(frame(9000));
    s.endOfSpeech();
    await done;
    const final = uploads[uploads.length - 1]!;
    expect(final).toMatchObject({ language: 'en', prompt: 'Kafka' });
    expect(final.bytes).toBe(44 + 10 * 3200); // silence discarded
    expect(events.filter((e) => !e.startsWith('i:'))).toEqual(['f:How would you scale it?', 'end']);
    s.close();
  });

  it('says plainly when the speech engine is not running', async () => {
    const stt = new LocalWhisperTranscriber('http://127.0.0.1:9', fetch);
    await expect(stt.open({ language: '', vocabulary: [] }, { onInterim() {}, onFinalSegment() {}, onUtteranceEnd() {}, onError() {}, onClose() {} })).rejects.toMatchObject({ code: 'network' });
  });
});
