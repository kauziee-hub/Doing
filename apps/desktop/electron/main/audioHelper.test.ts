import { describe, expect, it } from 'vitest';
import { FrameDecoder, HEADER_LEN } from './audioHelper';

function frame(kind: number, source: number, seq: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(HEADER_LEN);
  h.write('VC', 0, 'latin1');
  h[2] = 1;
  h[3] = kind;
  h[4] = source;
  h[5] = 0;
  h.writeUInt32LE(seq, 8);
  h.writeBigUInt64LE(123456n, 12);
  h.writeUInt32LE(payload.length, 20);
  return Buffer.concat([h, payload]);
}

describe('FrameDecoder (mirror of native protocol.rs)', () => {
  it('decodes frames split across arbitrary chunk boundaries', () => {
    const stream = Buffer.concat([frame(1, 1, 0, Buffer.alloc(640, 7)), frame(2, 0, 0, Buffer.from('{"type":"hello"}')), frame(1, 2, 5, Buffer.alloc(640, 9))]);
    for (const step of [1, 7, 24, 100, 663, stream.length]) {
      const d = new FrameDecoder();
      const out = [];
      for (let i = 0; i < stream.length; i += step) out.push(...d.push(stream.subarray(i, i + step)));
      expect(out.map((f) => [f.kind, f.source, f.seq, f.payload.length])).toEqual([
        [1, 'mic', 0, 640],
        [2, 'none', 0, 16],
        [1, 'system', 5, 640],
      ]);
      expect(out[0]!.timestampUs).toBe(123456);
    }
  });

  it('rejects desynchronised or oversized input', () => {
    expect(() => new FrameDecoder().push(Buffer.from('garbage-garbage-garbage-garbage'))).toThrow(/magic/);
    const big = frame(1, 1, 0, Buffer.alloc(0));
    big.writeUInt32LE(10 * 1024 * 1024, 20);
    expect(() => new FrameDecoder().push(big)).toThrow(/too large/);
  });
});
