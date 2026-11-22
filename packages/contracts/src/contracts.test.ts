import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, DEFAULT_HOTKEYS, defaultSettings, detectSecrets, redactSecrets, IPC_CHANNELS, IpcRequestSchemas } from './index';

describe('settings schema', () => {
  it('produces complete conservative defaults from an empty object', () => {
    const s = defaultSettings();
    expect(s.onboardingComplete).toBe(false);
    expect(s.privacy.saveHistory).toBe(false); // history is opt-in
    expect(s.overlay.contentProtection).toBe(true); // overlay left out of screen shares unless the user turns it off
    expect(s.engine.tier).toBe('auto'); // hardware decides the models
    expect(s.hotkeys).toEqual(DEFAULT_HOTKEYS);
    // Local-only: no provider, key or budget settings exist any more.
    expect(Object.keys(s)).not.toEqual(expect.arrayContaining(['providers']));
    expect(Object.keys(s)).not.toEqual(expect.arrayContaining(['budget']));
  });

  it('a 0.2.x settings file loads leniently: old provider sections are dropped, the rest kept', () => {
    const old = {
      schemaVersion: 1,
      onboardingComplete: true,
      providers: { cloud: { enabled: true, model: 'openai/gpt-oss-20b' }, ollama: { enabled: true, model: 'qwen3.5:4b' } },
      answer: { primaryProvider: 'ollama', fallbackProvider: 'cloud', format: 'paragraph', length: 'medium' },
      stt: { provider: 'cloud-whisper', language: 'en', geminiMode: 'VERBATIM', endpointingMs: 600 },
      budget: { dailyAnswerLimit: 150 },
      knowledge: { useEmbeddings: true, embeddingModel: 'gemini-embedding-001', topK: 6 },
      overlay: { contentProtection: true, opacity: 0.9 },
    };
    // Mirrors SettingsStore: zod strips the removed keys; only the version literal needs the lenient path.
    const r = AppSettingsSchema.safeParse({ ...old, schemaVersion: 2 });
    expect(r.success).toBe(true);
    const s = r.data!;
    expect(s.onboardingComplete).toBe(true);
    expect(s.stt.language).toBe('en');
    expect(s.knowledge.topK).toBe(6);
    expect(s.overlay.opacity).toBe(0.9);
    // One assistant since 0.3.1: an old saved mode is read as it, without losing the section.
    expect(AppSettingsSchema.parse({ answer: { mode: 'coding', length: 'long' } }).answer).toMatchObject({ mode: 'assistant', length: 'long', screen: 'auto' });
    expect('providers' in s || 'budget' in s || 'primaryProvider' in s.answer || 'provider' in s.stt).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(AppSettingsSchema.safeParse({ overlay: { opacity: 5 } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ answer: { length: 'huge' } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ answer: { screen: 'secretly' } }).success).toBe(false);
  });

  it('every IPC channel has a request schema', () => {
    expect(IPC_CHANNELS.length).toBeGreaterThan(45);
    for (const c of IPC_CHANNELS) expect(IpcRequestSchemas[c]).toBeDefined();
    expect(IpcRequestSchemas['session:start'].safeParse({ consent: false }).success).toBe(false);
    expect(IpcRequestSchemas['session:start'].safeParse({ consent: true }).success).toBe(true);
    // No channel accepts API keys or provider choices any more.
    expect(IPC_CHANNELS.some((c) => c.startsWith('secrets:') || c.startsWith('providers:'))).toBe(false);
    expect(IpcRequestSchemas['engine:setup'].safeParse(undefined).success).toBe(true);
  });
});

describe('secret detection', () => {
  const fakeGoogle = 'AIza' + 'Sy'.padEnd(35, 'A');
  const fakeAq = 'AQ.' + 'Ab'.padEnd(48, 'x');
  it('finds common credential formats and masks previews', () => {
    const text = [
      `GEMINI_KEY=${fakeGoogle}`,
      `NEW_KEY ${fakeAq}`,
      'aws AKIAABCDEFGHIJKLMNOP',
      'token ghp_' + 'a'.repeat(36),
      'password: hunter2hunter2',
      'postgres://admin:s3cretpass@db.local/app',
      '-----BEGIN PRIVATE KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----',
      'card 4111 1111 1111 1111',
    ].join('\n');
    const found = detectSecrets(text);
    const kinds = found.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['Google API key', 'AWS access key ID', 'GitHub token', 'Password / secret assignment', 'Credentials in URL', 'Private key block', 'Payment card number']));
    for (const f of found) expect(f.preview).not.toContain(text.slice(f.start, f.end));
    const red = redactSecrets(text, found);
    expect(red).not.toContain(fakeGoogle);
    expect(red).not.toContain(fakeAq);
    expect(red).not.toContain('hunter2hunter2');
    expect(red).not.toContain('4111 1111 1111 1111');
  });

  it('does not flag ordinary prose or Luhn-invalid numbers', () => {
    expect(detectSecrets('The password policy requires rotation. Order 1234 5678 9012 3456 shipped.')).toEqual([]);
  });
});
