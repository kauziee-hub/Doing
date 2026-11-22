import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppSettings } from '@hirora/contracts';
import { AppSettingsSchema, defaultSettings } from '@hirora/contracts';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep merge where arrays and primitives in `patch` replace those in `base`.
 * A key prefixed with '=' replaces the whole value instead of merging (used to
 * delete entries from records, e.g. `{ budget: { '=prices': {...} } }`).
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (k.startsWith('=')) {
      out[k.slice(1)] = v;
      continue;
    }
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Loads settings, repairing invalid/old files by falling back field-by-field to defaults. */
export function parseSettingsLenient(raw: unknown): AppSettings {
  const full = AppSettingsSchema.safeParse(raw);
  if (full.success) return full.data;
  // Merge onto defaults section by section, keeping whatever sections still validate.
  let merged = defaultSettings();
  if (isPlainObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const candidate = deepMerge(merged, { [k]: v });
      const r = AppSettingsSchema.safeParse(candidate);
      if (r.success) merged = r.data;
    }
  }
  return merged;
}

export class SettingsStore {
  private value: AppSettings;
  private listeners = new Set<(s: AppSettings, prev: AppSettings) => void>();

  constructor(private readonly path: string) {
    this.value = this.load();
  }

  private load(): AppSettings {
    if (!existsSync(this.path)) return defaultSettings();
    try {
      return parseSettingsLenient(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      // Corrupt file: keep a copy for diagnosis and start from defaults.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return defaultSettings();
    }
  }

  get(): AppSettings {
    return this.value;
  }

  /** Validates the merged result; throws (and changes nothing) if invalid. */
  update(patch: Record<string, unknown>): AppSettings {
    const merged = deepMerge(this.value, patch);
    const parsed = AppSettingsSchema.parse(merged);
    const prev = this.value;
    this.value = parsed;
    atomicWrite(this.path, JSON.stringify(parsed, null, 2));
    for (const l of this.listeners) l(parsed, prev);
    return parsed;
  }

  replace(next: AppSettings): AppSettings {
    const parsed = AppSettingsSchema.parse(next);
    const prev = this.value;
    this.value = parsed;
    atomicWrite(this.path, JSON.stringify(parsed, null, 2));
    for (const l of this.listeners) l(parsed, prev);
    return parsed;
  }

  onChange(fn: (s: AppSettings, prev: AppSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
