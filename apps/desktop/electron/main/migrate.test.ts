import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_MARKER, migrateLegacyProfile, profileInUse } from './migrate';

function legacyProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hirora-legacy-'));
  writeFileSync(join(dir, 'settings.json'), '{"a":1}');
  writeFileSync(join(dir, 'secrets.json'), '{"gemini":"ENCRYPTED"}');
  writeFileSync(join(dir, 'Local State'), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
  writeFileSync(join(dir, 'veyracue.db'), 'db');
  writeFileSync(join(dir, 'veyracue.db-wal'), 'wal');
  writeFileSync(join(dir, 'lockfile'), '');
  mkdirSync(join(dir, 'Cache'));
  writeFileSync(join(dir, 'Cache', 'big'), 'x');
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'veyracue.log'), 'log');
  return dir;
}
const newTarget = () => join(mkdtempSync(join(tmpdir(), 'hirora-new-')), 'Hirora');

describe('migrateLegacyProfile', () => {
  it('copies keys, Local State and data, renames the db, skips caches and locks, leaves the source alone', () => {
    const legacy = legacyProfile();
    const target = newTarget();
    const r = migrateLegacyProfile(legacy, target);
    expect(r).toEqual({ outcome: 'copied', copied: true, renamedDb: true, backedUpDb: null, error: null });
    expect(readFileSync(join(target, 'secrets.json'), 'utf8')).toContain('ENCRYPTED');
    expect(readFileSync(join(target, 'Local State'), 'utf8')).toContain('LEGACY');
    expect(readFileSync(join(target, 'doing.db'), 'utf8')).toBe('db');
    expect(readFileSync(join(target, 'doing.db-wal'), 'utf8')).toBe('wal');
    expect(existsSync(join(target, 'veyracue.db'))).toBe(false);
    expect(existsSync(join(target, 'lockfile'))).toBe(false);
    expect(existsSync(join(target, 'Cache'))).toBe(false);
    expect(existsSync(join(target, 'logs', 'veyracue.log'))).toBe(true);
    expect(existsSync(join(target, MIGRATION_MARKER))).toBe(true);
    // Source untouched.
    expect(existsSync(join(legacy, 'veyracue.db'))).toBe(true);
    expect(existsSync(join(legacy, 'lockfile'))).toBe(true);
    // Never twice.
    expect(migrateLegacyProfile(legacy, target).outcome).toBe('already-done');
  });

  it('repairs a key-less Hirora profile left by a launch that skipped migration, backing up its db', () => {
    const legacy = legacyProfile();
    const target = newTarget();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'settings.json'), '{"fresh":true}');
    writeFileSync(join(target, 'Local State'), '{"os_crypt":{"encrypted_key":"NEW"}}');
    writeFileSync(join(target, 'doing.db'), 'fresh-db');
    writeFileSync(join(target, 'doing.db-wal'), 'fresh-wal');
    const r = migrateLegacyProfile(legacy, target);
    expect(r).toMatchObject({ outcome: 'copied', copied: true, renamedDb: true, backedUpDb: 'doing.db.before-migration' });
    expect(readFileSync(join(target, 'Local State'), 'utf8')).toContain('LEGACY');
    expect(readFileSync(join(target, 'secrets.json'), 'utf8')).toContain('ENCRYPTED');
    expect(readFileSync(join(target, 'doing.db'), 'utf8')).toBe('db');
    expect(readFileSync(join(target, 'doing.db.before-migration'), 'utf8')).toBe('fresh-db');
    expect(readFileSync(join(target, 'doing.db.before-migration-wal'), 'utf8')).toBe('fresh-wal');
  });

  it('never overwrites a Hirora profile that has its own saved keys', () => {
    const legacy = legacyProfile();
    const target = newTarget();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'secrets.json'), '{"xai":"MINE"}');
    writeFileSync(join(target, 'settings.json'), '{"mine":true}');
    const r = migrateLegacyProfile(legacy, target);
    expect(r).toMatchObject({ outcome: 'target-has-keys', copied: false });
    expect(readFileSync(join(target, 'secrets.json'), 'utf8')).toContain('MINE');
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"mine":true}');
    expect(migrateLegacyProfile(legacy, target).outcome).toBe('already-done');
  });

  it('does nothing without a legacy profile', () => {
    const target = newTarget();
    expect(migrateLegacyProfile(join(target, '..', 'missing'), target)).toMatchObject({ outcome: 'no-legacy', copied: false });
    expect(migrateLegacyProfile('', target).outcome).toBe('no-legacy');
    expect(existsSync(target)).toBe(false);
  });

  it('postpones without a marker while either profile is open in a running instance', () => {
    const legacy = legacyProfile();
    const target = newTarget();
    const busyTarget = migrateLegacyProfile(legacy, target, (d) => d === target);
    expect(busyTarget.outcome).toBe('in-use');
    expect(existsSync(join(target, 'secrets.json'))).toBe(false);
    expect(existsSync(join(target, MIGRATION_MARKER))).toBe(false);
    expect(migrateLegacyProfile(legacy, target, (d) => d === legacy).outcome).toBe('in-use');
    // Once nothing holds the profiles, the next launch migrates normally.
    expect(migrateLegacyProfile(legacy, target, () => false).outcome).toBe('copied');
  });

  it('treats a stale, unheld lockfile as not in use', () => {
    const legacy = legacyProfile(); // contains a plain 'lockfile' nobody holds
    expect(profileInUse(legacy)).toBe(false);
    expect(profileInUse(newTarget())).toBe(false);
  });
});
