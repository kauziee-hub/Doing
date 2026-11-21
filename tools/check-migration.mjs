#!/usr/bin/env node
// Diagnoses the VeyraCue → Hirora profile migration against a COPY of a legacy profile.
// Never touches the real %APPDATA% folders and never prints key material.
//   node tools/check-migration.mjs <path-to-Hirora.exe or electron.exe> [appDir]
import { _electron as electron } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
const appDir = process.argv[3];
const realLegacy = join(process.env.APPDATA, 'VeyraCue');
const legacy = mkdtempSync(join(tmpdir(), 'hirora-legacy-'));
cpSync(realLegacy, legacy, { recursive: true, filter: (s) => !/[\\/](Cache|Code Cache|GPUCache|DawnCache|blob_storage|lockfile)([\\/]|$)/.test(s) });
const target = join(mkdtempSync(join(tmpdir(), 'hirora-target-')), 'Hirora');

const app = await electron.launch({ executablePath: exe, args: appDir ? [appDir] : [], env: { ...process.env, HIRORA_USER_DATA: target, HIRORA_MIGRATE_FROM: legacy } });
const info = await app.evaluate(async ({ app: a }) => ({ appData: a.getPath('appData'), userData: a.getPath('userData'), name: a.getName(), packaged: a.isPackaged }));
const legacyDefault = join(info.appData, 'VeyraCue');
const status = await app.evaluate(async ({ app: a }) => a.getPath('userData'));
await new Promise((r) => setTimeout(r, 1500));
const page = await app.firstWindow();
const secrets = await page.evaluate(() => window.hirora.invoke('secrets:status')).catch((e) => ({ error: String(e) }));
await app.close();
console.log(JSON.stringify({
  info,
  defaultLegacyExists: existsSync(legacyDefault),
  defaultLegacyHasSettings: existsSync(join(legacyDefault, 'settings.json')),
  userDataUsed: status,
  targetFiles: existsSync(target) ? readdirSync(target).sort() : null,
  keysPresent: secrets.providers ? Object.entries(secrets.providers).filter(([, v]) => v.hasKey).map(([k]) => k) : secrets,
}, null, 2));
rmSync(legacy, { recursive: true, force: true });
rmSync(join(target, '..'), { recursive: true, force: true });
