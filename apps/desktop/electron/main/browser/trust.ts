import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const GrantSchema = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/), extensionId: z.string().regex(/^[a-p]{32}$/) });
export type BrowserGrant = z.infer<typeof GrantSchema>;
export interface BrowserTrustStore {
  load(): BrowserGrant | null;
  save(grant: BrowserGrant): void;
  clear(): void;
}

/** Only the connection credential persists. Windows safeStorage encrypts it with DPAPI. */
export function browserTrustStore(
  file: string,
  cipher: { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string },
): BrowserTrustStore {
  return {
    load() {
      try {
        return cipher.available() && existsSync(file) ? GrantSchema.parse(JSON.parse(cipher.decrypt(readFileSync(file)))) : null;
      } catch {
        return null;
      }
    },
    save(grant) {
      if (!cipher.available()) throw new Error('Windows credential encryption is unavailable. Restart Doing before connecting a browser.');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, cipher.encrypt(JSON.stringify(GrantSchema.parse(grant))), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
    clear() {
      rmSync(file, { force: true });
      rmSync(`${file}.tmp`, { force: true });
    },
  };
}
