import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, deepMerge, parseSettingsLenient } from './index';

const tmp = () => mkdtempSync(join(tmpdir(), 'vc-settings-'));

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
    s.update({ overlay: { opacity: 0.8 }, answer: { length: 'long' } });
    expect(() => s.update({ overlay: { opacity: 9 } })).toThrow();
    const reloaded = new SettingsStore(path);
    expect(reloaded.get().overlay.opacity).toBe(0.8);
    expect(reloaded.get().answer.length).toBe('long');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('recovers from a corrupt file and keeps valid sections of a partially invalid one', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{not json');
    expect(new SettingsStore(path).get().schemaVersion).toBe(2);
    expect(readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(true);
    const lenient = parseSettingsLenient({ overlay: { opacity: 99 }, answer: { length: 'long' } });
    expect(lenient.answer.length).toBe('long');
    expect(lenient.overlay.opacity).toBe(0.98);
  });
});

describe('upgrade from 0.2.x', () => {
  it('keeps the user choices and drops provider, key and budget settings', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        onboardingComplete: true,
        providers: { cloud: { enabled: true, model: 'openai/gpt-oss-20b', baseUrl: 'https://hirora-one.vercel.app/v1' } },
        answer: { primaryProvider: 'ollama', fallbackProvider: 'cloud', format: 'paragraph', length: 'medium' },
        stt: { provider: 'local-whisper', language: 'en', geminiMode: 'VERBATIM', endpointingMs: 600, localWhisperUrl: 'http://127.0.0.1:8178' },
        budget: { dailyAnswerLimit: 150, prices: {} },
        overlay: { contentProtection: true },
        audio: { systemDeviceId: 'all', micDeviceId: 'buds' },
      }),
    );
    const s = new SettingsStore(path).get();
    expect(s.schemaVersion).toBe(2);
    expect(s.onboardingComplete).toBe(true);
    expect(s.stt.language).toBe('en');
    expect(s.stt.customVocabulary).toEqual([]);
    expect(s.stt.streamingTranscription).toBe(false);
    expect(s.answer.format).toBe('paragraph');
    expect(s.audio.micDeviceId).toBe('buds');
    expect(JSON.stringify(s)).not.toMatch(/vercel|cloud|primaryProvider|budget/);
  });
});
