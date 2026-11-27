/**
 * Doing brand: the wordmark "Doıng" in heavy geometric strokes, and the mark, its D on an ink
 * squircle with the blush dot the ı gave up. Geometry is shared with brand/*.svg,
 * tools/make-icons.mjs, the website partials and tools/make-og.py: keep them in sync.
 */
export const BRAND = { ink: '#1d1c35', blush: '#f4a3b4', paper: '#ffffff' };

/** The D in the wordmark's 100-unit grid (stroke 22, miter corners). */
export const D_PATH = 'M11 11 H40 A39 39 0 0 1 40 89 H11 Z';
export const MARK_DOT = { cx: 48.5, cy: 17, r: 5.6 };

export function LogoMark({ size = 32, title = 'Doing', inverted = false }: { size?: number; title?: string; inverted?: boolean }) {
  const bg = inverted ? BRAND.paper : BRAND.ink;
  const fg = inverted ? BRAND.ink : BRAND.paper;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <rect width="64" height="64" rx="19" fill={bg} />
      <path transform="translate(13 15) scale(0.34)" d={D_PATH} fill="none" stroke={fg} strokeWidth="22" strokeLinejoin="miter" />
      <circle cx={MARK_DOT.cx} cy={MARK_DOT.cy} r={MARK_DOT.r} fill={BRAND.blush} />
    </svg>
  );
}

/** "Doıng" in the current text colour; `height` is the cap-to-descender height in px. */
export function Wordmark({ height = 18, title = 'Doing' }: { height?: number; title?: string }) {
  return (
    <svg className="vc-wordmark" height={height} width={(height * 367) / 141} viewBox="0 0 367 141" role="img" aria-label={title}>
      <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinejoin="miter">
        <path d={D_PATH} />
        <circle cx="135" cy="62" r="27" />
        <path d="M192 24 V100" />
        <path d="M222 24 V100 M222 59 A24 24 0 0 1 270 59 V100" />
        <circle cx="329" cy="62" r="27" />
        <path d="M356 24 V106 A24 24 0 0 1 332 130 H311" />
      </g>
    </svg>
  );
}
