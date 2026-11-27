import { desktopCapturer, screen } from 'electron';
import type { WindowManager } from './windows';

export interface ScreenShot {
  base64: string;
  width: number;
  height: number;
  displayLabel: string;
}

/**
 * Captures the monitor the user is working on (where the mouse is), downscaled to at most
 * `maxWidth`, as JPEG in memory only. 1600 px (was 1280): measured 2026-11-27 on a 3200x2000
 * screen at 200% with a coding problem, qwen3.5:4b read the title and signature at 1600 and
 * missed the title at 1280; about 1,600 prompt tokens with the picture, first word in 1.4 s. Doing's own windows are excluded from the capture for
 * that moment even when the user turned screen-share hiding off, so an answer never shows up
 * in the picture it is about.
 */
export async function captureScreen(windows: WindowManager | null, maxWidth = 1600): Promise<ScreenShot | null> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const ours = windows?.all() ?? [];
  for (const w of ours) w.setContentProtection(true);
  try {
    const sf = display.scaleFactor;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) } });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    let img = src.thumbnail;
    if (img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' });
    return { base64: img.toJPEG(82).toString('base64'), width: img.getSize().width, height: img.getSize().height, displayLabel: display.label || 'Display' };
  } finally {
    windows?.restoreContentProtection();
  }
}
