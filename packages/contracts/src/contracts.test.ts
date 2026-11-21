import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, DEFAULT_HOTKEYS, defaultSettings, detectSecrets, redactSecrets, IPC_CHANNELS, IpcRequestSchemas } from './index';

describe('settings schema', () => {
  it('produces complete conservative defaults from an empty object', () => {
    const s = defaultSettings();
    expect(s.onboardingComplete).toBe(false);
    expect(s.privacy.saveHistory).toBe(false); // history is opt-in
    expect(s.overlay.contentProtection).toBe(true); // overlay left out of screen shares unless the user turns it off
    expect(s.answer.primaryProvider).toBeNull();
    expect(s.providers.gemini.model).toBe(''); // no hard-coded model ids
    expect(s.budget.dailyAnswerLimit).toBeGreaterThan(0);
    expect(s.hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  it('rejects out-of-range values', () => {
    expect(AppSettingsSchema.safeParse({ overlay: { opacity: 5 } }).success).toBe(false);
    expect(AppSettingsSchema.safeParse({ answer: { mode: 'stealth' } }).success).toBe(false);
  });

  it('every IPC channel has a request schema', () => {
    expect(IPC_CHANNELS.length).toBeGreaterThan(50);
    for (const c of IPC_CHANNELS) expect(IpcRequestSchemas[c]).toBeDefined();
    expect(IpcRequestSchemas['session:start'].safeParse({ consent: false }).success).toBe(false);
    expect(IpcRequestSchemas['session:start'].safeParse({ consent: true }).success).toBe(true);
    expect(IpcRequestSchemas['secrets:set'].safeParse({ provider: 'gemini', key: 'x' }).success).toBe(false);
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
