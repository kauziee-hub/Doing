import { BrowserWindow, app, nativeTheme, screen, shell } from 'electron';
import type { Rectangle } from 'electron';
import { join } from 'node:path';
import type { Bounds } from '@doing/contracts';
import type { SettingsStore } from '@doing/settings';
import type { Logger } from './logger';

const preloadPath = () => join(__dirname, '../preload/index.cjs');
/** Windows use a dedicated session so UI network policy never affects main-process provider calls. */
export const UI_PARTITION = 'persist:doing-ui';

function rendererUrl(page: 'index' | 'overlay'): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && !app.isPackaged) return { url: `${dev}/${page}.html` };
  return { file: join(__dirname, `../renderer/${page}.html`) };
}

function hardenWebContents(win: BrowserWindow, log: Logger): void {
  const wc = win.webContents;
  // No navigation away from the bundled app and no new windows.
  wc.on('will-navigate', (e, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL);
    if (!allowed && !url.startsWith('file://')) {
      e.preventDefault();
      log.warn('blocked navigation', { url: url.slice(0, 120) });
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

export function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Ensures saved bounds are still on a connected display (monitor unplugged, DPI change). */
export function validateBounds(saved: Bounds | null): Rectangle {
  const displays = screen.getAllDisplays();
  if (saved) {
    const visible = displays.some((d) => {
      const wa = d.workArea;
      const overlapW = Math.min(saved.x + saved.width, wa.x + wa.width) - Math.max(saved.x, wa.x);
      const overlapH = Math.min(saved.y + saved.height, wa.y + wa.height) - Math.max(saved.y, wa.y);
      return overlapW >= 120 && overlapH >= 60;
    });
    if (visible) return { ...saved };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(460, Math.round(wa.width * 0.34));
  const height = Math.min(600, Math.round(wa.height * 0.7));
  return { x: wa.x + wa.width - width - 24, y: wa.y + 72, width, height };
}

export class WindowManager {
  dashboard: BrowserWindow | null = null;
  overlay: BrowserWindow | null = null;
  quitting = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly log: Logger,
    private readonly devTools: boolean,
  ) {}

  createDashboard(): BrowserWindow {
    if (this.dashboard && !this.dashboard.isDestroyed()) return this.dashboard;
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 920,
      minHeight: 620,
      show: false,
      title: 'Doing',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0f14' : '#f6f7fb',
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath(),
        partition: UI_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        devTools: this.devTools,
      },
    });
    hardenWebContents(win, this.log);
    // The dashboard can show your rÃ©sumÃ©, transcript and answers too: same capture rule as the overlay.
    this.applyContentProtection(win, this.settings.get().overlay.contentProtection);
    const target = rendererUrl('index');
    void (target.url ? win.loadURL(target.url) : win.loadFile(target.file!));
    win.once('ready-to-show', () => {
      if (!process.argv.includes('--hidden')) win.show();
    });
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    this.dashboard = win;
    return win;
  }

  createOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    const s = this.settings.get().overlay;
    const b = validateBounds(s.bounds);
    const win = new BrowserWindow({
      ...b,
      minWidth: 300,
      minHeight: 120,
      show: false,
      frame: false,
      transparent: true,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: s.alwaysOnTop,
      title: 'Doing Overlay',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath(),
        partition: UI_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
        devTools: this.devTools,
      },
    });
    hardenWebContents(win, this.log);
    if (s.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
    win.setOpacity(s.opacity);
    this.applyContentProtection(win, s.contentProtection);
    const target = rendererUrl('overlay');
    void (target.url ? win.loadURL(target.url) : win.loadFile(target.file!));
    const persist = () => {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const nb = win.getBounds();
        const display = screen.getDisplayMatching(nb);
        this.settings.update({ overlay: { bounds: nb, displayId: display.id } });
      }, 400);
    };
    win.on('moved', persist);
    win.on('resized', persist);
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    this.overlay = win;
    return win;
  }

  /** Uses only the documented Electron API (SetWindowDisplayAffinity on Windows). Best-effort. */
  applyContentProtection(win: BrowserWindow | null, enabled: boolean): void {
    if (!win || win.isDestroyed()) return;
    try {
      win.setContentProtection(enabled);
    } catch (err) {
      this.log.warn('setContentProtection failed', { error: (err as Error).message });
    }
  }

  /** Puts the user's screen-share setting back on every Doing window. */
  restoreContentProtection(): void {
    const on = this.settings.get().overlay.contentProtection;
    for (const w of this.all()) this.applyContentProtection(w, on);
  }

  applyOverlaySettings(): void {
    const s = this.settings.get().overlay;
    this.applyContentProtection(this.dashboard, s.contentProtection);
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    w.setOpacity(s.opacity);
    w.setAlwaysOnTop(s.alwaysOnTop, 'screen-saver');
    this.applyContentProtection(w, s.contentProtection);
  }

  /** Show without taking focus (never steal focus from the user's meeting/editor). */
  showOverlay(focus = false): void {
    const w = this.createOverlay();
    if (!w.isVisible()) w.showInactive();
    if (focus) {
      w.focus();
    }
  }

  toggleOverlay(): boolean {
    const w = this.createOverlay();
    if (w.isVisible()) {
      w.hide();
      return false;
    }
    w.showInactive();
    return true;
  }

  moveOverlayToNextDisplay(): void {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    const displays = screen.getAllDisplays();
    if (displays.length < 2) return;
    const cur = screen.getDisplayMatching(w.getBounds());
    const idx = displays.findIndex((d) => d.id === cur.id);
    const next = displays[(idx + 1) % displays.length]!;
    const b = w.getBounds();
    const relX = (b.x - cur.workArea.x) / Math.max(1, cur.workArea.width);
    const relY = (b.y - cur.workArea.y) / Math.max(1, cur.workArea.height);
    const wa = next.workArea;
    const width = Math.min(b.width, wa.width);
    const height = Math.min(b.height, wa.height);
    w.setBounds({
      x: Math.round(Math.min(wa.x + relX * wa.width, wa.x + wa.width - width)),
      y: Math.round(Math.min(wa.y + relY * wa.height, wa.y + wa.height - height)),
      width,
      height,
    });
  }

  revalidateOverlay(): void {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    const fixed = validateBounds(w.getBounds());
    w.setBounds(fixed);
  }

  showDashboard(): void {
    const w = this.createDashboard();
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  all(): BrowserWindow[] {
    return [this.dashboard, this.overlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
  }
}
