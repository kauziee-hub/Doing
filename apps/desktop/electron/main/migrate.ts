import { closeSync, cpSync, existsSync, openSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Hirora was called VeyraCue before 0.2.0; its profile lived in %APPDATA%\VeyraCue. */
export const LEGACY_PROFILE_DIR_NAME = 'VeyraCue';
const LEGACY_DB = 'veyracue.db';
export const DB_FILE = 'doing.db';
/** Written once a migration decision is final, so a profile is never migrated twice. */
export const MIGRATION_MARKER = '.migrated-from-veyracue';

/** Chromium caches and locks: rebuilt on demand, never worth copying. */
const SKIP = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage', 'Shared Dictionary']);

export type MigrationOutcome = 'no-legacy' | 'already-done' | 'target-has-keys' | 'in-use' | 'copied' | 'error';

export interface MigrationResult {
  outcome: MigrationOutcome;
  copied: boolean;
  renamedDb: boolean;
  /** A database the new profile already had, kept aside instead of deleted. */
  backedUpDb: string | null;
  error: string | null;
}

/**
 * True while an Electron/Chromium process has this folder open as its userData.
 * Chromium keeps `lockfile` open for writing (share-read only) and deletes it on
 * exit — measured on Windows 11: opening it read/write fails with EBUSY while the
 * app runs, and the file is gone after the process exits, even after a forced kill.
 */
export function profileInUse(dir: string): boolean {
  const lock = join(dir, 'lockfile');
  if (!existsSync(lock)) return false;
  try {
    closeSync(openSync(lock, 'r+'));
    return false; // stale lockfile left by something else: not held
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
}

function hasProfile(dir: string): boolean {
  return existsSync(join(dir, 'settings.json')) || existsSync(join(dir, 'secrets.json'));
}

function markDone(targetDir: string, outcome: MigrationOutcome): void {
  writeFileSync(join(targetDir, MIGRATION_MARKER), JSON.stringify({ outcome, at: new Date().toISOString() }));
}

/**
 * Copies a legacy (VeyraCue) profile into the Hirora userData folder before
 * Chromium reads `Local State` (it holds the DPAPI-wrapped key that safeStorage
 * uses, so saved API keys stay decryptable). Runs on every launch until it has
 * made a final decision, so a launch that skipped it can't strand the user's keys.
 *
 * A Hirora profile that already has its own saved keys is never overwritten. One
 * without keys (e.g. created by a launch that skipped migration) is replaced by the
 * legacy profile; its database, if any, is kept as `hirora.db.before-migration`.
 * Postponed (no marker) while either profile is open in a running instance.
 * The legacy folder is never modified. Must run synchronously before
 * `app.requestSingleInstanceLock()` / app ready.
 */
export function migrateLegacyProfile(legacyDir: string, targetDir: string, inUse: (dir: string) => boolean = profileInUse): MigrationResult {
  const result: MigrationResult = { outcome: 'no-legacy', copied: false, renamedDb: false, backedUpDb: null, error: null };
  try {
    if (!legacyDir || legacyDir === targetDir || !existsSync(legacyDir) || !hasProfile(legacyDir)) return result;
    if (existsSync(join(targetDir, MIGRATION_MARKER))) {
      result.outcome = 'already-done';
      return result;
    }
    // Never copy into (or out of) a profile another running instance has open: an
    // older Hirora/VeyraCue window would keep writing its db and settings. No marker
    // is written, so the next launch tries again once those windows are closed.
    if (inUse(targetDir) || inUse(legacyDir)) {
      result.outcome = 'in-use';
      return result;
    }
    if (existsSync(join(targetDir, 'secrets.json'))) {
      result.outcome = 'target-has-keys';
      markDone(targetDir, result.outcome);
      return result;
    }
    const legacyHasDb = existsSync(join(legacyDir, LEGACY_DB));
    if (legacyHasDb && existsSync(join(targetDir, DB_FILE))) {
      // Keep whatever a key-less Hirora profile had, instead of silently dropping it.
      const backup = `${DB_FILE}.before-migration`;
      for (const suffix of ['', '-wal', '-shm']) {
        const from = join(targetDir, `${DB_FILE}${suffix}`);
        if (existsSync(from)) renameSync(from, join(targetDir, `${backup}${suffix}`));
      }
      result.backedUpDb = backup;
    }
    cpSync(legacyDir, targetDir, { recursive: true, force: true, filter: (src) => !SKIP.has(basename(src)) });
    result.copied = true;
    for (const name of readdirSync(targetDir)) {
      if (name === LEGACY_DB || name === `${LEGACY_DB}-wal` || name === `${LEGACY_DB}-shm`) {
        renameSync(join(targetDir, name), join(targetDir, name.replace(LEGACY_DB, DB_FILE)));
        result.renamedDb = true;
      }
    }
    result.outcome = 'copied';
    markDone(targetDir, result.outcome);
  } catch (err) {
    result.outcome = 'error';
    result.error = (err as Error).message;
  }
  return result;
}
