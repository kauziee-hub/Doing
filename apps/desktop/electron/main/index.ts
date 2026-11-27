import { app, dialog, net, powerMonitor, safeStorage, screen, session } from 'electron';
import { dirname, join } from 'node:path';
import type { HotkeyAction } from '@hirora/contracts';
import { Logger } from './logger';
import { AppServices } from './services';
import { UI_PARTITION, WindowManager } from './windows';
import { HotkeyManager, TrayController } from './shell';
import { registerIpc } from './ipc';
import { LEGACY_PROFILE_DIR_NAME, migrateLegacyProfile } from './migrate';
import { UpdateManager } from './updates';
import { BrowserAgent } from './browser/agent';
import { createBrowserPlanner, createBrowserReader } from './browser/planner';
import { browserTrustStore } from './browser/trust';
import { createBrowserChatter } from './browser/chat';
import { LocalAgent } from './local/agent';
import { createLocalPlanner } from './local/planner';

const processStart = performance.timeOrigin;

if (process.env.HIRORA_USER_DATA) app.setPath('userData', process.env.HIRORA_USER_DATA);
// The app is called Doing since 0.4.0, but its settings, documents and history stay in the
// folder they have always been in (Electron would otherwise switch to %APPDATA%\Doing).
else app.setPath('userData', join(app.getPath('appData'), 'Hirora'));
app.setAppUserModelId('app.hirora.desktop');

// Carry a pre-rename (VeyraCue) profile over before Chromium loads `Local State`.
// HIRORA_MIGRATE_FROM lets tests point at a copied legacy profile.
const migration = migrateLegacyProfile(
  process.env.HIRORA_MIGRATE_FROM ?? (process.env.HIRORA_USER_DATA ? '' : join(app.getPath('appData'), LEGACY_PROFILE_DIR_NAME)),
  app.getPath('userData'),
);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

function applyUiSessionSecurity(): void {
  const ses = session.fromPartition(UI_PARTITION);
  const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  // Renderers never need camera/mic/screen/notifications etc.: audio and screen
  // capture happen in the main process / native helper behind explicit UI.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // No remote content: block any http(s) request from UI windows except the dev server.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    const allowed = !!dev && (details.url.startsWith(dev) || details.url.startsWith(dev.replace('http', 'ws')));
    cb({ cancel: !allowed });
  });
  ses.webRequest.onHeadersReceived((details, cb) => {
    const devSrc = dev ? ` ${dev} ${dev.replace('http', 'ws')}` : '';
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'${devSrc}; script-src 'self'${dev ? " 'unsafe-inline'" : ''}${devSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'${devSrc}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        ],
      },
    });
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  const log = new Logger(join(app.getPath('userData'), 'logs'));
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged });
  if (migration.outcome === 'error') log.error('legacy profile migration failed', { ...migration });
  else if (migration.outcome !== 'no-legacy' && migration.outcome !== 'already-done') log.info('legacy profile migration', { ...migration });
  applyUiSessionSecurity();

  let services: AppServices;
  try {
    services = new AppServices(log);
  } catch (err) {
    log.error('fatal init error', { error: (err as Error).message });
    dialog.showErrorBox('Doing failed to start', (err as Error).message);
    app.exit(1);
    return;
  }

  const devTools = !app.isPackaged || process.env.HIRORA_DEVTOOLS === '1';
  const windows = new WindowManager(services.settings, log, devTools);
  services.windows = windows;
  const paintTokens = new Map<string, { at: number; stage: 'hotkey_to_paint' }>();

  const toggleListening = async () => {
    const st = services.session.sessionState;
    if (st === 'listening' || st === 'paused') {
      await services.session.stop();
    } else {
      // Starting capture always goes through the visible consent step in the UI.
      windows.showOverlay(false);
      services.emit({ type: 'command', command: 'requestStart' });
    }
    tray.refresh();
  };

  const tray = new TrayController({
    showDashboard: () => windows.showDashboard(),
    toggleOverlay: () => windows.toggleOverlay(),
    toggleListening: () => void toggleListening(),
    quit: () => {
      windows.quitting = true;
      app.quit();
    },
    isListening: () => services.session.sessionState === 'listening',
  });

  const onHotkey = (action: HotkeyAction, firedAt: number) => {
    const token = `hk:${action}:${Math.round(firedAt)}`;
    paintTokens.set(token, { at: firedAt, stage: 'hotkey_to_paint' });
    if (paintTokens.size > 50) paintTokens.delete(paintTokens.keys().next().value as string);
    switch (action) {
      case 'toggleOverlay': {
        const visible = windows.toggleOverlay();
        if (visible) services.emit({ type: 'command', command: 'paintProbe', arg: token });
        else paintTokens.delete(token);
        return;
      }
      case 'askNow':
        windows.showOverlay(false);
        services.session.askLatest();
        services.emit({ type: 'command', command: 'paintProbe', arg: token });
        return;
      case 'toggleListening':
        void toggleListening();
        paintTokens.delete(token);
        return;
      case 'pauseListening':
        void (services.session.sessionState === 'paused' ? services.session.resume() : services.session.pause()).then(() => tray.refresh());
        services.emit({ type: 'command', command: 'paintProbe', arg: token });
        return;
      case 'cancelAnswer':
        browser.stop();
        local.stop();
        services.answer.cancel('user');
        services.emit({ type: 'command', command: 'paintProbe', arg: token });
        return;
      case 'focusAsk':
        // The one hotkey that intentionally takes focus: the user wants to type.
        windows.showOverlay(true);
        services.emit({ type: 'command', command: 'focusAsk', arg: token });
        return;
      case 'nextMonitor':
        windows.moveOverlayToNextDisplay();
        paintTokens.delete(token);
        return;
      case 'toggleCompact': {
        const compact = !services.settings.get().overlay.compact;
        services.settings.update({ overlay: { compact } });
        services.emit({ type: 'command', command: 'setCompact', arg: { compact, token } });
        return;
      }
      case 'screenContext':
        // Answer from the screen at once; the overlay shows without taking focus from the
        // browser or call the question is in.
        windows.showOverlay();
        paintTokens.delete(token);
        void services.askFromScreen().then((r) => {
          if (r.error) services.emit({ type: 'toast', level: 'error', message: r.error });
        });
        return;
    }
  };

  const hotkeys = new HotkeyManager(services.settings, onHotkey, log);
  const updates = new UpdateManager({
    fetchImpl: (url, init) => net.fetch(url, init),
    log,
    current: process.env.HIRORA_UPDATE_AS_VERSION?.trim() || app.getVersion(),
    packaged: app.isPackaged,
    installDir: dirname(process.execPath),
    tempDir: app.getPath('temp'),
    autoCheck: () => services.settings.get().updates.checkAutomatically,
    notify: (message) => services.emit({ type: 'toast', level: 'info', message }),
    quit: () => app.quit(),
  });
  const browserTrust = browserTrustStore(join(app.getPath('userData'), 'browser-connection.bin'), {
    available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text), decrypt: (data) => safeStorage.decryptString(data),
  });
  const browser = new BrowserAgent(createBrowserPlanner(services), Number(process.env.HIRORA_BROWSER_PORT ?? 19389), browserTrust, () => {
    windows.showDashboard();
    services.emit({ type: 'command', command: 'navigate', arg: 'browser' });
  }, createBrowserReader(services), createBrowserChatter(services));
  void browser.enable().catch(() => services.emit({ type: 'toast', level: 'warn', message: 'Browser connection could not start. Open Browser assistant to reconnect.' }));
  const local = new LocalAgent(createLocalPlanner(services));
  registerIpc({ services, windows, hotkeys, tray, paintTokens, updates, browser, local });
  updates.startAutoCheck();

  const dash = windows.createDashboard();
  dash.once('ready-to-show', () => {
    services.recordPerf({ stage: 'app_cold_start', ms: performance.timeOrigin + performance.now() - processStart, at: Date.now(), provider: null, model: null, label: app.isPackaged ? 'packaged' : 'dev' });
  });
  windows.createOverlay();
  tray.create();
  hotkeys.registerAll();
  services.helper.start();
  // Instant answers: once set up, have speech recognition and the answer model loaded before the first question.
  void services.warmUp();

  screen.on('display-removed', () => windows.revalidateOverlay());
  screen.on('display-metrics-changed', () => windows.revalidateOverlay());
  powerMonitor.on('suspend', () => {
    local.stop();
    browser.stop();
    log.info('system suspend');
    if (services.session.sessionState === 'listening') void services.session.pause().then(() => {
      services.emit({ type: 'toast', level: 'info', message: 'Listening paused because the computer went to sleep. Resume when ready.' });
      tray.refresh();
    });
  });
  powerMonitor.on('resume', () => {
    log.info('system resume');
    if (!services.helper.running) services.helper.start();
  });

  app.on('second-instance', () => windows.showDashboard());
  app.on('before-quit', () => {
    local.revoke();
    browser.shutdown();
    windows.quitting = true;
  });
  app.on('will-quit', (e) => {
    updates.stop();
    hotkeys.dispose();
    tray.destroy();
    if (services.helper.running) {
      e.preventDefault();
      void services.shutdown().finally(() => app.exit(0));
    }
  });
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
}
