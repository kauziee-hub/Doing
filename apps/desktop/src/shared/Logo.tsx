/**
 * Hirora brand mark: an ink squircle with a lowercase "h" whose shoulder is a
 * rising arch (the aurora) and a blush dot beside it — the cue.
 * Geometry is shared with tools/make-icons.mjs and the website: keep them in sync.
 */
export const BRAND = { ink: '#1d1c35', blush: '#f4a3b4', paper: '#ffffff' };

/** Stem, arch and dot in the 64-unit grid. */
export const MARK_PATH = 'M20 16.5 V49 M20 36.5 A10 10 0 0 1 40 36.5 V49';
export const MARK_DOT = { cx: 45, cy: 16, r: 5.4 };

export function LogoMark({ size = 32, title = 'Hirora', inverted = false }: { size?: number; title?: string; inverted?: boolean }) {
  const bg = inverted ? BRAND.paper : BRAND.ink;
  const fg = inverted ? BRAND.ink : BRAND.paper;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <rect width="64" height="64" rx="19" fill={bg} />
      <path d={MARK_PATH} fill="none" stroke={fg} strokeWidth="7.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={MARK_DOT.cx} cy={MARK_DOT.cy} r={MARK_DOT.r} fill={BRAND.blush} />
    </svg>
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="vc-wordmark" style={{ fontSize: size }}>
      <span className="vc-wordmark__a">Hir</span>
      <span className="vc-wordmark__b">ora</span>
    </span>
  );
}
