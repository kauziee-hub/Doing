#!/usr/bin/env node
/**
 * Downloads the pinned unofficial SAVA ONNX (Apache-2.0) for Hirora.
 * Official inworld/sava is PyTorch-only.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const URL = 'https://huggingface.co/matthiastl/sava-onnx/resolve/main/sava-int8.onnx';
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'resources', 'sava', 'sava-int8.onnx');

mkdirSync(dirname(dest), { recursive: true });
const res = await fetch(URL);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
await pipeline(res.body, createWriteStream(dest));
console.log('wrote', dest);
