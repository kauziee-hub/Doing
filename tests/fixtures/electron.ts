import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Electron 45 downloads its development binary when its package entry is loaded.
// Resolving through that entry also handles a fresh checkout with no dist/ yet.
export const electronExecutable = (): string =>
  createRequire(join(resolve(__dirname, '../../apps/desktop'), 'package.json'))('electron') as string;
