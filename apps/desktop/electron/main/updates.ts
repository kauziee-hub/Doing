import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateStatus } from '@hirora/contracts';
import type { FetchFn } from './engine/download';
import { downloadPinned, sha256File } from './engine/download';
import type { Logger } from './logger';
import { LATEST_RELEASE_API, parseLatestRelease } from './updateInfo';
import type { UpdateInfo } from './updateInfo';

export interface UpdateDeps {
  fetchImpl: FetchFn;
  log: Logger;
  /** This app's version (`HIRORA_UPDATE_AS_VERSION` pretends to be an older one, for tests). */
  current: string;
  /** Only an installed (packaged) app installs updates; a dev build can still check. */
  packaged: boolean;
  /** Folder the app runs from: the new version is installed over it. */
  installDir: string;
  /** Where the installer is downloaded (the OS temp folder). */
  tempDir: string;
  autoCheck: () => boolean;
  notify: (message: string) => void;
  quit: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Updates from GitHub Releases (0.3.8): checks the latest release, and on the user's click
 * downloads its installer (resumable), checks size and SHA-256, runs it silently over this
 * install and quits; the installer starts the new version when it's done. Nothing installs
 * without that click. The automatic check (on by default, Settings → Updates) only asks GitHub
 * once a day and says when a newer version is out.
 */
export class UpdateManager {
  private info: UpdateInfo | null = null;
  private notified: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private s: UpdateStatus;

  constructor(private readonly deps: UpdateDeps) {
    this.s = { current: deps.current, phase: 'idle', latest: null, notes: null, pageUrl: null, bytes: null, done: null, checkedAt: null, error: null, canInstall: deps.packaged };
  }

  status(): UpdateStatus {
    return { ...this.s };
  }

  private get busy(): boolean {
    return this.s.phase === 'checking' || this.s.phase === 'downloading' || this.s.phase === 'verifying' || this.s.phase === 'installing';
  }

  async check(byUser = true): Promise<UpdateStatus> {
    if (this.busy) return this.status();
    this.s = { ...this.s, phase: 'checking', error: null };
    try {
      const res = await this.deps.fetchImpl(LATEST_RELEASE_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Hirora/${this.deps.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) throw new Error('No release is published on GitHub yet.');
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}; try again later.`);
      const info = parseLatestRelease(await res.json(), this.deps.current);
      this.info = info;
      this.s = { ...this.s, phase: info.newer ? 'available' : 'up-to-date', latest: info.latest, notes: info.notes, pageUrl: info.pageUrl, bytes: info.bytes, done: null, checkedAt: Date.now() };
      if (!byUser && info.newer && this.notified !== info.latest) {
        this.notified = info.latest;
        this.deps.notify(`Hirora ${info.latest} is available. Settings → Updates installs it.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.s = { ...this.s, phase: 'error', error: /fetch|network|ENOTFOUND|ECONN|timed? ?out|abort/i.test(message) ? 'Couldn’t reach GitHub to check for updates. Check the internet connection.' : message, checkedAt: Date.now() };
      if (!byUser) this.deps.log.info('update check failed', { error: message });
    }
    return this.status();
  }

  /** Once shortly after start, then once a day, while the setting is on. */
  startAutoCheck(firstAfterMs = 30_000): void {
    const tick = (ms: number) => {
      this.timer = setTimeout(() => {
        if (this.deps.autoCheck()) void this.check(false);
        tick(DAY_MS);
      }, ms);
      this.timer.unref?.();
    };
    tick(firstAfterMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  install(): { ok: boolean; error: string | null } {
    if (!this.deps.packaged) return { ok: false, error: 'Updates install only in the installed app.' };
    const info = this.info;
    if (!info?.newer) return { ok: false, error: 'There is no newer version to install. Check for updates first.' };
    if (this.busy) return { ok: false, error: 'An update is already in progress.' };
    this.s = { ...this.s, phase: 'downloading', done: 0, error: null };
    void this.run(info);
    return { ok: true, error: null };
  }

  private async run(info: UpdateInfo): Promise<void> {
    const dest = join(this.deps.tempDir, 'hirora-update', info.file);
    try {
      // Downloaded before (an earlier try that didn't finish installing) and still intact: reuse it.
      const ready = existsSync(dest) && (await sha256File(dest)) === info.sha256;
      if (!ready) await downloadPinned({ url: info.url, sha256: info.sha256, bytes: info.bytes, file: info.file }, dest, {
        fetchImpl: this.deps.fetchImpl,
        signal: new AbortController().signal,
        onProgress: (p) => {
          this.s = { ...this.s, done: p.done };
        },
        onVerify: () => {
          this.s = { ...this.s, phase: 'verifying' };
        },
      });
      this.s = { ...this.s, phase: 'installing', done: info.bytes };
      this.deps.log.info('installing update', { from: this.deps.current, to: info.latest });
      // electron-builder's NSIS installer: silent, as an update, start the app when done, into
      // this folder. /D= must come last and unquoted (NSIS rule), so the arguments are passed
      // verbatim with only the installer path quoted.
      const child = spawn(dest, ['--updated', '/S', '--force-run', `/D=${this.deps.installDir}`], {
        argv0: `"${dest}"`,
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      // Let the installer start, then close so it can replace the files.
      setTimeout(() => this.deps.quit(), 1_500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn('update failed', { error: message });
      this.s = { ...this.s, phase: 'error', error: `The update didn’t install: ${message}` };
    }
  }
}
