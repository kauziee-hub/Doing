import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { profileInUse } from "./migrate";

const MARKER = ".migrated-from-hirora";
const SKIP = new Set([
  "lockfile",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
  "blob_storage",
  "Shared Dictionary",
]);
const hash = (file: string) => {
  const fd = openSync(file, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, length));
    return digest.digest("hex");
  } finally {
    closeSync(fd);
  }
};

/**
 * A Doing folder left inside an app container. MSIX-packaged tools (found on this PC: Codex and
 * Claude) start child processes with AppData writes redirected into
 * %LOCALAPPDATA%\Packages\<package>\LocalCache\{Roaming,Local}, so a Doing launched from one of
 * them kept its profile and engine there, where a normal launch never looks (2026-11-27: the
 * owner's documents and settings were in Codex's LocalCache). Returns the newest such folder that
 * holds `marker`, or null. Read-only.
 */
export function containerCopy(localAppData: string, kind: "Roaming" | "Local", marker: string): string | null {
  const packages = join(localAppData, "Packages");
  let names: string[];
  try {
    names = readdirSync(packages);
  } catch {
    return null;
  }
  let best: { path: string; at: number } | null = null;
  for (const name of names) {
    const dir = join(packages, name, "LocalCache", kind, "Doing");
    try {
      const at = lstatSync(join(dir, marker)).mtimeMs;
      if (!best || at > best.at) best = { path: dir, at };
    } catch {
      /* no Doing data in this package */
    }
  }
  return best?.path ?? null;
}

/** Copies individual files, including Chromium's encryption key, before Electron reads the profile.
 * The original remains a rollback copy. Interrupted copies resume without overwriting changed data. */
export function migrateDoingDirectory(
  legacy: string,
  target: string,
  profile = false,
): boolean {
  if (
    legacy === target ||
    !existsSync(legacy) ||
    existsSync(join(target, MARKER))
  )
    return false;
  if (profile && (profileInUse(legacy) || profileInUse(target)))
    throw new Error(
      "Quit the previous Doing or Hirora app before updating. Your data has not been changed.",
    );
  // A pre-existing Doing profile belongs to the user; never merge another profile into it.
  const pending = join(target, ".migration-pending");
  if (existsSync(target) && lstatSync(target).isSymbolicLink())
    throw new Error("Choose a data folder without a link.");
  if (
    profile &&
    !existsSync(pending) &&
    (existsSync(join(target, "settings.json")) ||
      existsSync(join(target, "doing.db")))
  )
    return false;
  mkdirSync(target, { recursive: true });
  writeFileSync(pending, "hirora");
  const copy = (source: string, destination: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const from = join(source, entry.name);
      if (entry.isSymbolicLink() || lstatSync(from).isSymbolicLink())
        throw new Error(
          "A linked data folder needs to be migrated separately. The original is preserved.",
        );
      const name = profile
        ? entry.name.replace(/^hirora\.db(?=$|-)/, "doing.db")
        : entry.name;
      const to = join(destination, name);
      if (entry.isDirectory()) {
        if (existsSync(to) && lstatSync(to).isSymbolicLink())
          throw new Error(
            "The migration destination contains a linked folder.",
          );
        mkdirSync(to, { recursive: true });
        copy(from, to);
      } else if (entry.isFile()) {
        if (existsSync(to)) {
          if (
            lstatSync(to).isSymbolicLink() ||
            !lstatSync(to).isFile() ||
            hash(from) !== hash(to)
          )
            throw new Error(
              "Doing data already exists at the migration destination. The original is preserved.",
            );
        } else {
          const staging = `${to}.migrating-${randomUUID()}`;
          try {
            copyFileSync(from, staging, constants.COPYFILE_EXCL);
            renameSync(staging, to);
          } finally {
            if (existsSync(staging)) unlinkSync(staging);
          }
        }
      }
    }
  };
  copy(legacy, target);
  writeFileSync(
    join(target, MARKER),
    JSON.stringify({ at: new Date().toISOString(), legacy }),
  );
  unlinkSync(pending);
  return true;
}
