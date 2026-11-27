import { describe, expect, it } from 'vitest';
import { compareVersions, parseLatestRelease } from './updateInfo';

const SHA = 'b1137ca8afa5de1c91855bb8a8c6f9ad04c963ceec190ea64ff6ad5d9d178054';
const release = (over: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
  tag_name: 'v0.3.9',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/kauziee-hub/Doing/releases/tag/v0.3.9',
  published_at: '2026-11-27T01:00:00Z',
  body: 'Doing runs on your PC.\n\n### What changed\n- Updates from inside the app.\n\n### Download\n`Doing-Setup-0.3.9-x64-unsigned.exe`\n\nSHA-256: `' + SHA + '`',
  assets: [
    { name: 'notes.txt', size: 10, browser_download_url: 'https://github.com/kauziee-hub/Doing/releases/download/v0.3.9/notes.txt' },
    { name: 'Doing-Setup-0.3.9-x64-unsigned.exe', size: 142_873_509, digest: `sha256:${SHA}`, browser_download_url: 'https://github.com/kauziee-hub/Doing/releases/download/v0.3.9/Doing-Setup-0.3.9-x64-unsigned.exe', ...asset },
  ],
  ...over,
});

describe('updates from GitHub releases', () => {
  it('compares versions', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('v0.3.8', '0.3.8')).toBe(0);
    expect(compareVersions('0.3.7', '0.4.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '0.9.9')).toBe(1);
  });

  it('reads the installer, its size and checksum, and whether it is newer', () => {
    const u = parseLatestRelease(release(), '0.3.8');
    expect(u).toMatchObject({ latest: '0.3.9', newer: true, file: 'Doing-Setup-0.3.9-x64-unsigned.exe', bytes: 142_873_509, sha256: SHA });
    expect(u.notes).toContain('Updates from inside the app.');
    expect(u.notes).not.toContain('SHA-256');
    expect(parseLatestRelease(release(), '0.3.9').newer).toBe(false);
    // No digest from GitHub: the SHA-256 line in the notes still pins the file.
    expect(parseLatestRelease(release({}, { digest: undefined }), '0.3.8').sha256).toBe(SHA);
    // Releases from before the rename (Hirora) are still recognised.
    expect(parseLatestRelease(release({}, { name: 'Hirora-Setup-0.3.9-x64-unsigned.exe' }), '0.3.8').file).toBe('Hirora-Setup-0.3.9-x64-unsigned.exe');
  });

  it('refuses anything it cannot check or that points elsewhere', () => {
    expect(() => parseLatestRelease(release({ prerelease: true }), '0.3.8')).toThrow(/not a finished version/);
    expect(() => parseLatestRelease(release({ assets: [] }), '0.3.8')).toThrow(/no Windows installer/);
    expect(() => parseLatestRelease(release({}, { browser_download_url: 'https://example.com/Doing-Setup-0.3.9-x64-unsigned.exe' }), '0.3.8')).toThrow(/somewhere unexpected/);
    expect(() => parseLatestRelease(release({ body: 'no checksum here' }, { digest: undefined }), '0.3.8')).toThrow(/no SHA-256/);
    // An installer whose name says another version than the release is ignored.
    expect(() => parseLatestRelease(release({}, { name: 'Doing-Setup-0.3.1-x64-unsigned.exe' }), '0.3.8')).toThrow(/no Windows installer/);
  });
});
