#!/usr/bin/env node
/**
 * Puts the SAVA end-of-turn model (unofficial Apache-2.0 ONNX export of inworld/sava; the
 * official release is PyTorch only) in apps/desktop/resources/sava so the installer ships it.
 * Pinned to one revision, size and SHA-256 like every engine download: a file that doesn't
 * match is deleted and the build stops. Does nothing when the right file is already there.
 *   node tools/fetch-sava-onnx.mjs
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REVISION = 'f27cfec88d2801c68f891a9f65a7f00afd82e9a5';
const URL = `https://huggingface.co/matthiastl/sava-onnx/resolve/${REVISION}/sava-int8.onnx`;
const SIZE = 26_457_983;
const SHA256 = '107b298acfd1d9a316fb5d396f95121e1100612becd1c1165d33388f348e8dd9';
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'resources', 'sava', 'sava-int8.onnx');

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

if (existsSync(dest) && statSync(dest).size === SIZE && (await sha256(dest)) === SHA256) {
  console.log('sava model already in place', dest);
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
const tmp = `${dest}.part`;
const res = await fetch(URL);
if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
const size = statSync(tmp).size;
const hash = await sha256(tmp);
if (size !== SIZE || hash !== SHA256) {
  rmSync(tmp, { force: true });
  throw new Error(`sava-int8.onnx does not match the pinned file (size ${size}, sha256 ${hash})`);
}
renameSync(tmp, dest);
console.log('wrote', dest, `(${size} bytes, sha256 ${hash})`);
