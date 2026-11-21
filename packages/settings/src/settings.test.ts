import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretVault, SettingsStore, deepMerge, parseSettingsLenient } from './index';
import type { SecretCipher } from './index';

const tmp = () => mkdtempSync(join(tmpdir(), 'vc-settings-'));

/** Test cipher (reversible XOR) — stands in for Electron safeStorage/DPAPI in unit tests only. */
class FakeCipher implements SecretCipher {
  backend = 'test-xor';
  isAvailable() {
    return true;
  }
  encrypt(p: string) {
    return Buffer.from([...Buffer.from(p)].map((b) => b ^ 0x5a));
  }
  decrypt(c: Buffer) {
    return Buffer.from([...c].map((b) => b ^ 0x5a)).toString();
  }
}

describe('deepMerge', () => {
  it('merges nested objects, replaces arrays, supports =replace and blocks prototype pollution', () => {
    const base = { a: { b: 1, c: [1, 2] }, rec: { x: 1, y: 2 } };
    expect(deepMerge(base, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] }, rec: { x: 1, y: 2 } });
    expect(deepMerge(base, { '=rec': { y: 3 } })).toEqual({ a: { b: 1, c: [1, 2] }, rec: { y: 3 } });
    const polluted = deepMerge({}, JSON.parse('{"__proto__": {"hacked": true}}'));
    expect(({} as Record<string, unknown>).hacked).toBeUndefined();
    expect(polluted).toEqual({});
  });
});

describe('SettingsStore', () => {
  it('persists validated updates atomically and rejects invalid ones', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const s = new SettingsStore(path);
    s.update({ overlay: { opacity: 0.8 }, answer: { mode: 'coding' } });
    expect(() => s.update({ overlay: { opacity: 9 } })).toThrow();
    const reloaded = new SettingsStore(path);
    expect(reloaded.get().overlay.opacity).toBe(0.8);
    expect(reloaded.get().answer.mode).toBe('coding');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('recovers from a corrupt file and keeps valid sections of a partially invalid one', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{not json');
    expect(new SettingsStore(path).get().schemaVersion).toBe(1);
    expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(true);
    const lenient = parseSettingsLenient({ overlay: { opacity: 99 }, answer: { mode: 'coding' } });
    expect(lenient.answer.mode).toBe('coding');
    expect(lenient.overlay.opacity).toBe(0.98);
  });
});

describe('SecretVault', () => {
  it('never writes plaintext keys and round-trips through the cipher', () => {
    const dir = tmp();
    const path = join(dir, 'secrets.json');
    const key = 'xai-' + 'Q'.repeat(40);
    const v = new SecretVault(path, new FakeCipher());
    v.set('xai', key);
    expect(readFileSync(path, 'utf8')).not.toContain(key);
    const v2 = new SecretVault(path, new FakeCipher());
    expect(v2.get('xai')).toBe(key);
    expect(v2.status().xai.hasKey).toBe(true);
    expect(v2.status().gemini.hasKey).toBe(false);
    v2.delete('xai');
    expect(v2.get('xai')).toBeNull();
    v2.deleteAll();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to store when OS encryption is unavailable or input is not a key', () => {
    const c = new FakeCipher();
    c.isAvailable = () => false;
    expect(() => new SecretVault(join(tmp(), 's.json'), c).set('gemini', 'abcdefghijk')).toThrow(/encryption/);
    expect(() => new SecretVault(join(tmp(), 's.json'), new FakeCipher()).set('gemini', 'has spaces in it')).toThrow();
  });
});
