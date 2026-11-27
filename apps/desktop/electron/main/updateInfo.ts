/**
 * What an update would install, read from the latest GitHub release (pure, unit-tested).
 * Installers are release assets of the public repository since 0.3.6; the SHA-256 comes from
 * the asset's `digest` that GitHub computes on upload (or, failing that, the "SHA-256:" line in
 * the release notes), and the download must match it before it is run.
 */
export const RELEASE_REPO = 'kauziee-hub/hirora';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`;
/** Doing-Setup-x.y.z from 0.4.0 (the app was called Hirora before). */
const INSTALLER = /^(?:Doing|Hirora)-Setup-(\d+\.\d+\.\d+)-x64(?:-unsigned)?\.exe$/;

export interface UpdateInfo {
  latest: string;
  newer: boolean;
  /** The release notes above their "Download" section. */
  notes: string;
  pageUrl: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  publishedAt: string | null;
}

/** -1, 0 or 1, comparing "major.minor.patch" (anything after a "-" is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

interface ReleaseJson {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
  assets?: Array<{ name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown }>;
}

/** Throws an Error with a message fit for the user when the release can't be installed from. */
export function parseLatestRelease(json: unknown, current: string): UpdateInfo {
  const r = (json ?? {}) as ReleaseJson;
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version || r.draft === true || r.prerelease === true) throw new Error('The latest release on GitHub is not a finished version.');
  const asset = (r.assets ?? []).find((a) => typeof a.name === 'string' && INSTALLER.exec(a.name)?.[1] === version);
  if (!asset) throw new Error(`Release ${tag} has no Windows installer attached.`);
  const url = String(asset.browser_download_url ?? '');
  if (!url.startsWith(DOWNLOAD_PREFIX)) throw new Error(`Release ${tag} points its installer somewhere unexpected.`);
  const body = typeof r.body === 'string' ? r.body : '';
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest ?? ''))?.[1] ?? /SHA-256:\s*`?([0-9a-f]{64})/i.exec(body)?.[1];
  if (!sha256) throw new Error(`Release ${tag} has no SHA-256 for its installer, so it can't be checked.`);
  const bytes = Number(asset.size);
  if (!Number.isFinite(bytes) || bytes < 1_000_000) throw new Error(`Release ${tag} lists an installer of an unexpected size.`);
  const notes = body.split(/^#{2,3}\s+Download\b/m)[0]!.trim().slice(0, 3000);
  return {
    latest: version,
    newer: compareVersions(version, current) > 0,
    notes,
    pageUrl: typeof r.html_url === 'string' && r.html_url.startsWith(`https://github.com/${RELEASE_REPO}/releases/`) ? r.html_url : `https://github.com/${RELEASE_REPO}/releases`,
    file: String(asset.name),
    url,
    bytes,
    sha256,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
  };
}
