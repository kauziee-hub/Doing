import { afterEach, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { browserTrustStore } from './trust';
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders)
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep + 'hirora-trust-test-')) rmSync(dir, { recursive: true, force: true });
  folders.length = 0;
});
it('persists only encrypted credentials, loads them, fails closed on corrupt data and forgets them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hirora-trust-test-'));
  folders.push(dir);
  const file = join(dir, 'grant.bin');
  const key = randomBytes(32);
  // Fixture cipher isolates persistence behavior; production uses Electron safeStorage/DPAPI.
  const store = browserTrustStore(file, {
    available: () => true,
    encrypt(text) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const payload = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), payload]);
    },
    decrypt(data) {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  });
  const grant = { token: 'ab'.repeat(24), extensionId: 'a'.repeat(32) };
  store.save(grant);
  expect(readFileSync(file).includes(grant.token)).toBe(false);
  expect(store.load()).toEqual(grant);
  writeFileSync(file, 'corrupt');
  expect(store.load()).toBeNull();
  store.clear();
  expect(store.load()).toBeNull();
  const unavailable = browserTrustStore(file, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
  expect(() => unavailable.save(grant)).toThrow('encryption is unavailable');
  expect(unavailable.load()).toBeNull();
});
