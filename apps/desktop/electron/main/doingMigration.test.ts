import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDoingDirectory } from "./doingMigration";
const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "doing-migration-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.length = 0;
});
it("preserves profile encryption, database WAL, documents and browser trust using individual file copies", () => {
  const dir = root(),
    old = join(dir, "Hirora"),
    target = join(dir, "Doing");
  mkdirSync(old);
  for (const [name, text] of Object.entries({
    "settings.json": "settings",
    "Local State": "encryption-key",
    "hirora.db": "documents",
    "hirora.db-wal": "pending-history",
    "browser-connection.bin": "encrypted-trust",
  }))
    writeFileSync(join(old, name), text);
  expect(migrateDoingDirectory(old, target, true)).toBe(true);
  expect(readFileSync(join(target, "doing.db"), "utf8")).toBe("documents");
  expect(readFileSync(join(target, "doing.db-wal"), "utf8")).toBe(
    "pending-history",
  );
  expect(readFileSync(join(target, "Local State"), "utf8")).toBe(
    "encryption-key",
  );
  expect(readFileSync(join(target, "browser-connection.bin"), "utf8")).toBe(
    "encrypted-trust",
  );
  expect(readFileSync(join(old, "hirora.db"), "utf8")).toBe("documents");
  expect(migrateDoingDirectory(old, target, true)).toBe(false);
});
it("resumes a partial migration and keeps a conflicting destination intact", () => {
  const dir = root(),
    old = join(dir, "old"),
    target = join(dir, "new");
  mkdirSync(old);
  mkdirSync(target);
  writeFileSync(join(old, "settings.json"), "same");
  writeFileSync(join(target, "settings.json"), "same");
  writeFileSync(join(target, ".migration-pending"), "hirora");
  writeFileSync(join(old, "hirora.db"), "db");
  expect(migrateDoingDirectory(old, target, true)).toBe(true);
  const engine = join(dir, "engine");
  mkdirSync(engine);
  writeFileSync(join(engine, "model.bin"), "original");
  const destination = join(dir, "models");
  mkdirSync(destination);
  writeFileSync(join(destination, "model.bin"), "user copy");
  expect(() => migrateDoingDirectory(engine, destination)).toThrow(
    "already exists",
  );
  expect(readFileSync(join(destination, "model.bin"), "utf8")).toBe(
    "user copy",
  );
});
it("never overwrites an existing Doing profile or follows junctions", () => {
  const dir = root(),
    old = join(dir, "old"),
    target = join(dir, "Doing");
  mkdirSync(old);
  mkdirSync(target);
  writeFileSync(join(old, "settings.json"), "old");
  writeFileSync(join(target, "settings.json"), "user settings");
  expect(migrateDoingDirectory(old, target, true)).toBe(false);
  const linked = join(dir, "linked");
  symlinkSync(old, linked, "junction");
  expect(() => migrateDoingDirectory(old, linked)).toThrow("without a link");
  expect(existsSync(join(target, ".migrated-from-hirora"))).toBe(false);
});
