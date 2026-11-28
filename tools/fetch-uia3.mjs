// Pinned MIT-licensed COM interop for the built-in Windows UI Automation API.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const dest = join(root, 'apps/desktop/resources/accessibility/Interop.UIAutomationClient.dll');
const digest = 'dcea43a1f5a2114b7bcc9e41cc1377064307611d0caa50f1ec203b887f4c20bb';
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (
  await readFile(dest).then(
    (b) => hash(b) === digest,
    () => false,
  )
)
  process.exit(0);
if (process.platform !== 'win32') process.exit(0);
const response = await fetch(
  'https://api.nuget.org/v3-flatcontainer/interop.uiautomationclient/10.19041.0/interop.uiautomationclient.10.19041.0.nupkg',
);
if (!response.ok) throw new Error('UIA interop download failed: ' + response.status);
const archive = Buffer.from(await response.arrayBuffer());
if (archive.length !== 245385 || hash(archive) !== '0d2ed17db2cb13a262f0580ab992db87577651c25a9899053df4114b4d9ff3b1')
  throw new Error('UIA interop package integrity mismatch');
await mkdir(join(root, 'test-results/uia3-download'), { recursive: true });
const packageFile = join(root, 'test-results/uia3-download/interop.nupkg');
await writeFile(packageFile, archive);
const dll = execFileSync('tar.exe', ['-xOf', packageFile, 'lib/net45/Interop.UIAutomationClient.dll'], {
  maxBuffer: 1 << 20,
  windowsHide: true,
});
if (hash(dll) !== digest) throw new Error('UIA interop library integrity mismatch');
await mkdir(join(root, 'apps/desktop/resources/accessibility'), { recursive: true });
const staged = join(root, 'test-results/uia3-download/Interop.UIAutomationClient.dll');
await writeFile(staged, dll);
await copyFile(staged, dest);
