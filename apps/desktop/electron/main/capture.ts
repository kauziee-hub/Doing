import { desktopCapturer, screen } from 'electron';
import type { BrowserWindow, NativeImage, Rectangle } from 'electron';
import { release } from 'node:os';
import type { CaptureCheckResult } from '@doing/contracts';
import type { AudioHelper } from './audioHelper';
import type { WindowManager } from './windows';
import type { Logger } from './logger';

/** The overlay paints this exact colour during the check. */
const PROBE_RGB = { r: 255, g: 0, b: 255 };

function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function averageFromImage(img: NativeImage, rect: Rectangle): { r: number; g: number; b: number } | null {
  const size = img.getSize();
  if (size.width === 0 || size.height === 0) return null;
  const crop = img.crop({
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.min(size.width - Math.round(rect.x), Math.round(rect.width))),
    height: Math.max(1, Math.min(size.height - Math.round(rect.y), Math.round(rect.height))),
  });
  const bmp = crop.toBitmap(); // BGRA on Windows
  const n = bmp.length / 4;
  if (n === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    b += bmp[i]!;
    g += bmp[i + 1]!;
    r += bmp[i + 2]!;
  }
  return { r: r / n, g: g / n, b: b / n };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sampleDesktopCapturer(win: BrowserWindow): Promise<{ r: number; g: number; b: number } | null> {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const sf = display.scaleFactor;
  const thumb = { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!src) return null;
  const img = src.thumbnail;
  const scaleX = img.getSize().width / display.size.width;
  const scaleY = img.getSize().height / display.size.height;
  // Sample the central 50% of the overlay to avoid rounded corners/shadows.
  const inner = {
    x: (bounds.x - display.bounds.x + bounds.width * 0.25) * scaleX,
    y: (bounds.y - display.bounds.y + bounds.height * 0.25) * scaleY,
    width: bounds.width * 0.5 * scaleX,
    height: bounds.height * 0.5 * scaleY,
  };
  return averageFromImage(img, inner);
}

async function sampleGdi(helper: AudioHelper, win: BrowserWindow): Promise<{ r: number; g: number; b: number } | null> {
  const b = win.getBounds();
  const inner = { x: b.x + b.width * 0.25, y: b.y + b.height * 0.25, width: b.width * 0.5, height: b.height * 0.5 };
  const phys = process.platform === 'win32' ? screen.dipToScreenRect(win, inner) : inner;
  const res = await helper.request<{ avg: { r: number; g: number; b: number } }>('capture_probe', {
    x: Math.round(phys.x),
    y: Math.round(phys.y),
    w: Math.max(1, Math.round(phys.width)),
    h: Math.max(1, Math.round(phys.height)),
  });
  return res.avg;
}

/**
 * Capture Compatibility Check. Paints a solid probe colour in the overlay and
 * samples the screen through two capture paths with content protection OFF
 * (baseline: the probe must be visible, otherwise the method is inconclusive)
 * and ON. Reports what was measured on this machine — nothing more.
 */
export async function runCaptureCheck(windows: WindowManager, helper: AudioHelper, contentProtectionSetting: boolean, log: Logger): Promise<CaptureCheckResult[]> {
  const win = windows.createOverlay();
  const wasVisible = win.isVisible();
  const prevOpacity = win.getOpacity();
  const results: CaptureCheckResult[] = [];
  const meta = { osRelease: `Windows ${release()}`, electron: process.versions.electron ?? '' };
  try {
    win.setOpacity(1);
    win.webContents.send('doing:live', { type: 'command', command: 'captureProbe', arg: true });
    if (!wasVisible) win.showInactive();
    await sleep(600);

    const methods: Array<{ id: string; description: string; sample: () => Promise<{ r: number; g: number; b: number } | null> }> = [
      {
        id: 'chromium-desktopCapturer',
        description: 'Chromium screen capture (desktopCapturer; Windows Graphics Capture / DXGI duplication, used by browser-based meeting apps)',
        sample: () => sampleDesktopCapturer(win),
      },
      {
        id: 'gdi-bitblt',
        description: 'GDI BitBlt(SRCCOPY|CAPTUREBLT) from the desktop DC (legacy recorders and screenshot tools)',
        sample: () => sampleGdi(helper, win),
      },
    ];

    for (const m of methods) {
      const testedAt = Date.now();
      try {
        windows.applyContentProtection(win, false);
        await sleep(300);
        const base = await m.sample();
        windows.applyContentProtection(win, true);
        await sleep(300);
        const prot = await m.sample();
        if (!base || !prot) {
          results.push({ method: m.id, description: m.description, result: 'error', detail: 'No pixels returned by this capture path.', contentProtectionEnabled: true, testedAt, ...meta });
          continue;
        }
        const baseDist = colorDistance(base, PROBE_RGB);
        const protDist = colorDistance(prot, PROBE_RGB);
        const fmt = (c: { r: number; g: number; b: number }) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
        if (baseDist > 60) {
          results.push({
            method: m.id,
            description: m.description,
            result: 'not_verified',
            detail: `Baseline did not see the probe (${fmt(base)}), so this method cannot be judged here (another window may cover the overlay).`,
            contentProtectionEnabled: true,
            testedAt,
            ...meta,
          });
          continue;
        }
        const hidden = protDist > 120;
        results.push({
          method: m.id,
          description: m.description,
          result: hidden ? 'hidden' : 'visible',
          detail: `Probe ${fmt(PROBE_RGB)}; baseline sample ${fmt(base)}; protected sample ${fmt(prot)}.`,
          contentProtectionEnabled: true,
          testedAt,
          ...meta,
        });
      } catch (err) {
        results.push({ method: m.id, description: m.description, result: 'error', detail: (err as Error).message, contentProtectionEnabled: true, testedAt, ...meta });
      }
    }
  } finally {
    windows.applyContentProtection(win, contentProtectionSetting);
    win.setOpacity(prevOpacity);
    win.webContents.send('doing:live', { type: 'command', command: 'captureProbe', arg: false });
    if (!wasVisible) win.hide();
  }
  log.info('capture check finished', { results: results.map((r) => `${r.method}:${r.result}`) });
  return results;
}
