import type { ParsedPage } from './parse';

export interface Chunk {
  ordinal: number;
  page: number | null;
  section: string | null;
  text: string;
}

export interface ChunkOptions {
  targetChars: number;
  overlapChars: number;
  minChars: number;
}

const DEFAULTS: ChunkOptions = { targetChars: 900, overlapChars: 150, minChars: 40 };

/** Split text into sentence-ish units without breaking code fences or list items. */
function units(text: string): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const p of paras) {
    const t = p.trim();
    if (!t) continue;
    if (t.length <= 400 || t.startsWith('```')) {
      out.push(t);
      continue;
    }
    // Split long paragraphs on sentence boundaries: punctuation followed by white space, so a
    // decimal ("0.25 s", "CGPA 8.50", "TLS 1.3") is never cut in two.
    const sentences = t.split(/(?<=[.!?]["')\]]?)\s+|\n+/).filter(Boolean);
    let buf = '';
    for (const s of sentences) {
      if (buf.length + 1 + s.length > 400 && buf) {
        out.push(buf.trim());
        buf = '';
      }
      buf += (buf ? ' ' : '') + s;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

export function chunkPages(pages: ParsedPage[], opts: Partial<ChunkOptions> = {}): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  let ordinal = 0;
  let section: string | null = null;

  for (const page of pages) {
    let buf = '';
    let bufSection = section;
    const flush = () => {
      const text = buf.trim();
      if (text.length >= o.minChars) {
        const key = text.toLowerCase().replace(/\s+/g, ' ');
        if (!seen.has(key)) {
          seen.add(key);
          chunks.push({ ordinal: ordinal++, page: page.page, section: bufSection, text });
        }
      }
      // carry overlap: last sentence-ish tail
      buf = text.length > o.overlapChars ? text.slice(-o.overlapChars).replace(/^\S*\s/, '') : '';
      bufSection = section;
    };
    for (const u of units(page.text)) {
      const heading = /^(#{1,6})\s+(.{1,120})$/.exec(u.split('\n')[0] ?? '');
      if (heading) {
        if (buf.trim().length >= o.minChars) flush();
        section = heading[2]!.trim();
        bufSection = section;
      }
      if (buf.length + u.length + 2 > o.targetChars && buf.trim().length > 0) flush();
      if (u.length > o.targetChars * 1.6) {
        // Hard-wrap giant units (e.g. minified code) at whitespace.
        for (let i = 0; i < u.length; i += o.targetChars) {
          buf += (buf ? '\n\n' : '') + u.slice(i, i + o.targetChars);
          flush();
        }
        continue;
      }
      buf += (buf ? '\n\n' : '') + u;
    }
    if (buf.trim().length >= o.minChars) {
      flush();
    }
  }
  return chunks;
}
