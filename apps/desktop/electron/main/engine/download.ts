import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { PinnedFile } from './catalog';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface Progress {
  done: number;
  total: number;
}

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Downloads a pinned file to `dest`, resuming a previous partial download (`.part`) with
 * an HTTP Range request, and refuses anything whose size or SHA-256 doesn't match.
 */
export async function downloadPinned(
  f: PinnedFile,
  dest: string,
  opts: { fetchImpl: FetchFn; signal: AbortSignal; onProgress: (p: Progress) => void; onVerify?: () => void },
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > f.bytes) {
    unlinkSync(part);
    have = 0;
  }
  if (have < f.bytes) {
    const headers: Record<string, string> = {};
    if (have > 0) headers.range = `bytes=${have}-`;
    const res = await opts.fetchImpl(f.url, { headers, signal: opts.signal, redirect: 'follow' });
    if (res.status === 200 && have > 0) have = 0; // server ignored the range: start over
    else if (!(res.ok || res.status === 206)) throw new Error(`Download failed (HTTP ${res.status}) for ${f.file}`);
    if (!res.body) throw new Error(`Empty response for ${f.file}`);
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    let done = have;
    let last = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        done += chunk.byteLength;
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          opts.onProgress({ done, total: f.bytes });
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    opts.onProgress({ done, total: f.bytes });
    if (done !== f.bytes) throw new Error(`Download of ${f.file} stopped at ${done} of ${f.bytes} bytes; press Set up again to resume.`);
  }
  opts.onVerify?.();
  const digest = await sha256File(part, opts.signal);
  if (digest !== f.sha256) {
    unlinkSync(part);
    throw new Error(`${f.file} failed its checksum (got ${digest.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…) and was deleted.`);
  }
  renameSync(part, dest);
}

/** Unpacks a .zip with Windows' built-in tar (libarchive), which handles multi-GB archives. */
export function extractZip(zip: string, destDir: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', destDir], { windowsHide: true, signal, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (err) reject(new Error(`Could not unpack ${zip.split(/[\\/]/).pop()}: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}
