import { Menu, Tray, globalShortcut, nativeImage, app } from 'electron';
import { join } from 'node:path';
import type { HotkeyAction } from '@hirora/contracts';
import { HOTKEY_LABELS } from '@hirora/contracts';
import type { SettingsStore } from '@hirora/settings';
import type { Logger } from './logger';

export function iconPath(name = 'icon.png'): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

export interface TrayActions {
  showDashboard(): void;
  toggleOverlay(): void;
  toggleListening(): void;
  quit(): void;
  isListening(): boolean;
}

export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly actions: TrayActions) {}

  create(): void {
    const img = nativeImage.createFromPath(iconPath('tray.png'));
    this.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    this.tray.setToolTip('Hirora');
    this.tray.on('click', () => this.actions.showDashboard());
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;
    const listening = this.actions.isListening();
    this.tray.setToolTip(listening ? 'Hirora — LISTENING (audio is being transcribed)' : 'Hirora — idle');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: listening ? '● Listening — stop' : 'Start listening…', click: () => this.actions.toggleListening() },
        { type: 'separator' },
        { label: 'Show dashboard', click: () => this.actions.showDashboard() },
        { label: 'Show / hide overlay', click: () => this.actions.toggleOverlay() },
        { type: 'separator' },
        { label: 'Quit Hirora', click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

export type HotkeyHandler = (action: HotkeyAction, firedAt: number) => void;

export class HotkeyManager {
  failures: Array<{ action: HotkeyAction; accelerator: string; reason: string }> = [];

  constructor(
    private readonly settings: SettingsStore,
    private readonly handler: HotkeyHandler,
    private readonly log: Logger,
  ) {}

  registerAll(): void {
    globalShortcut.unregisterAll();
    this.failures = [];
    const hk = this.settings.get().hotkeys;
    const seen = new Map<string, HotkeyAction>();
    for (const [action, accel] of Object.entries(hk) as Array<[HotkeyAction, string]>) {
      if (!accel) continue;
      const norm = accel.toLowerCase();
      if (seen.has(norm)) {
        this.failures.push({ action, accelerator: accel, reason: `Same shortcut as “${HOTKEY_LABELS[seen.get(norm)!]}”` });
        continue;
      }
      seen.set(norm, action);
      let ok: boolean;
      try {
        ok = globalShortcut.register(accel, () => this.handler(action, performance.timeOrigin + performance.now()));
      } catch (err) {
        this.failures.push({ action, accelerator: accel, reason: `Invalid shortcut: ${(err as Error).message}` });
        continue;
      }
      if (!ok) this.failures.push({ action, accelerator: accel, reason: 'Already in use by another application' });
    }
    if (this.failures.length) this.log.warn('hotkey registration failures', { failures: this.failures.map((f) => `${f.action}:${f.reason}`) });
  }

  dispose(): void {
    globalShortcut.unregisterAll();
  }
}
