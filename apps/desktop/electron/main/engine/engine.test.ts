import { fixturePort } from '../../../../../tests/fixtures/ports';
/**
 * FIXTURE tests for the engine installer: a local HTTP server serves a file (with Range
 * support) so resuming and checksum checks can be exercised offline. The real downloads
 * are exercised by tools/engine-setup-check.mjs against GitHub / Hugging Face / Ollama.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, GPU_TIER_MIN_VRAM_MB, resolveTier } from './catalog';
import { downloadPinned, extractZip } from './download';

const payload = randomBytes(300_000);
const sha = createHash('sha256').update(payload).digest('hex');
let server: Server;
let base = '';
const ranges: Array<string | undefined> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m) {
      const from = Number(m[1]);
      res.writeHead(206, { 'content-length': payload.length - from, 'content-range': `bytes ${from}-${payload.length - 1}/${payload.length}` });
      res.end(payload.subarray(from));
      return;
    }
    res.writeHead(200, { 'content-length': payload.length });
    res.end(payload);
  });
  const port = await fixturePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const tmp = () => mkdtempSync(join(tmpdir(), 'hirora-engine-'));
const opts = () => ({ fetchImpl: (u: string, i?: RequestInit) => fetch(u, i), signal: new AbortController().signal, onProgress: () => undefined });

describe('engine tiers', () => {
  it('uses the GPU tier only on an NVIDIA card with enough memory, unless the user chose', () => {
    expect(resolveTier('auto', { vramMb: 8188 })).toBe('gpu');
    expect(resolveTier('auto', { vramMb: 6144 })).toBe('gpu');
    expect(resolveTier('auto', { vramMb: 4096 })).toBe('cpu');
    expect(resolveTier('auto', null)).toBe('cpu');
    expect(resolveTier('cpu', { vramMb: 24_000 })).toBe('cpu');
    expect(resolveTier('gpu', null)).toBe('gpu');
    expect(GPU_TIER_MIN_VRAM_MB).toBeLessThan(6144);
  });

  it('pins every download to an exact size and SHA-256', () => {
    for (const tier of ['gpu', 'cpu'] as const) {
      const c = CATALOG[tier];
      for (const f of [c.speechRuntime, c.speechModel]) {
        expect(f.url).toMatch(/^https:\/\/(github\.com|huggingface\.co)\//);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(1_000_000);
      }
      expect(c.answerModel.tag).toMatch(/^qwen3(\.5)?:/);
    }
  });
});

describe('downloadPinned (fixture server)', () => {
  it('downloads, verifies and renames into place', async () => {
    const dest = join(tmp(), 'f.bin');
    await downloadPinned({ url: `${base}/f`, sha256: sha, bytes: payload.length, file: 'f.bin' }, dest, opts());
    expect(readFileSync(dest).equals(payload)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('resumes a partial download with a Range request', async () => {
    const dest = join(tmp(), 'f.bin');
    writeFileSync(`${dest}.part`, payload.subarray(0, 120_000));
    ranges.length = 0;
    await downloadPinned({ url: `${base}/f`, sha256: sha, bytes: payload.length, file: 'f.bin' }, dest, opts());
    expect(ranges).toEqual(['bytes=120000-']);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('deletes a download whose checksum does not match, and keeps nothing in place', async () => {
    const dest = join(tmp(), 'f.bin');
    await expect(downloadPinned({ url: `${base}/f`, sha256: '0'.repeat(64), bytes: payload.length, file: 'f.bin' }, dest, opts())).rejects.toThrow(/checksum/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('refuses a short download instead of installing it', async () => {
    const dest = join(tmp(), 'f.bin');
    await expect(downloadPinned({ url: `${base}/f`, sha256: sha, bytes: payload.length + 10, file: 'f.bin' }, dest, opts())).rejects.toThrow(/stopped at/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe('extractZip', () => {
  it('unpacks a zip with Windows tar', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'src', 'ollama.exe'), 'x');
    writeFileSync(join(dir, 'src', 'lib', 'a.dll'), 'y');
    const zip = join(dir, 'pack.zip');
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-cf', zip, '-C', join(dir, 'src'), 'ollama.exe', 'lib']);
    await extractZip(zip, join(dir, 'out'));
    expect(readFileSync(join(dir, 'out', 'ollama.exe'), 'utf8')).toBe('x');
    expect(readFileSync(join(dir, 'out', 'lib', 'a.dll'), 'utf8')).toBe('y');
  });
});
