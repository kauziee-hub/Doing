/**
 * FIXTURE test: a local HTTP server stands in for the Hirora Cloud relay so the
 * utterance buffering, WAV encoding and response filtering can be checked offline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CloudWhisperTranscriber, pcmToWav, whisperText } from './whisper';

let server: Server;
let base = '';
const uploads: Array<{ bytes: number; model: string | null; language: string | null; prompt: string | null }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.headers.authorization !== 'Bearer good-code') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Wrong or missing Hirora Cloud access code.' } }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      const file = form.get('file') as Blob;
      uploads.push({ bytes: file.size, model: form.get('model') as string | null, language: form.get('language') as string | null, prompt: form.get('prompt') as string | null });
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

const frame = (amp: number) => {
  const b = Buffer.alloc(3200); // 100 ms
  for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i / 4) * amp), i * 2);
  return b;
};

describe('CloudWhisperTranscriber (fixture relay)', () => {
  it('builds a valid 16 kHz mono WAV header', () => {
    const wav = pcmToWav(Buffer.alloc(320));
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(320);
    expect(whisperText({ text: 'fallback' })).toBe('fallback');
  });

  it('sends one utterance after the speaker pauses, drops no-speech segments, never sends silence', async () => {
    const events: string[] = [];
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const stt = new CloudWhisperTranscriber('good-code', base);
    const s = await stt.open(
      { language: 'en-IN', vocabulary: ['Kafka'], geminiMode: 'VERBATIM', endpointingMs: 600 },
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
    await new Promise((r) => setTimeout(r, 500));
    expect(uploads.length).toBe(0);
    // One second of speech, a short pause that resumes (same utterance), then the end.
    for (let i = 0; i < 6; i++) s.sendAudio(frame(9000));
    s.endOfSpeech();
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 4; i++) s.sendAudio(frame(9000));
    s.endOfSpeech();
    await done;
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({ model: 'whisper-large-v3-turbo', language: 'en', prompt: 'Kafka' });
    expect(uploads[0]!.bytes).toBe(44 + 10 * 3200); // silence discarded; both speech parts (6 + 4 frames) sent as one utterance
    expect(events).toEqual(['f:How would you scale it?', 'end']);
    s.close();
  });

  it('a wrong access code fails like a bad key', async () => {
    const stt = new CloudWhisperTranscriber('wrong', base);
    await expect(
      stt.open({ language: '', vocabulary: [], geminiMode: 'VERBATIM', endpointingMs: 600 }, { onInterim() {}, onFinalSegment() {}, onUtteranceEnd() {}, onError() {}, onClose() {} }),
    ).rejects.toMatchObject({ code: 'invalid_key' });
  });
});
