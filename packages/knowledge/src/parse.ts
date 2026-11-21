import { extname } from 'node:path';

export interface ParsedPage {
  page: number | null;
  text: string;
}

export interface ParsedDocument {
  mime: string;
  pages: ParsedPage[];
  pageCount: number | null;
  title: string;
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DOC_CHARS = 2_000_000;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.htm',
  '.log', '.rst', '.tex',
]);
const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.scala', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.go',
  '.rs', '.rb', '.php', '.swift', '.m', '.sql', '.sh', '.ps1', '.bat', '.r', '.jl', '.lua', '.dart', '.vue', '.svelte', '.css',
  '.scss', '.ipynb', '.gradle', '.dockerfile',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

export function supportedExtension(fileName: string): 'pdf' | 'docx' | 'text' | 'code' | 'image' | null {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (TEXT_EXT.has(ext)) return 'text';
  if (CODE_EXT.has(ext) || /^dockerfile$/i.test(fileName)) return 'code';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

export class IngestError extends Error {}

function decodeText(buf: Uint8Array): string {
  // Reject binary blobs masquerading as text.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nul = 0;
  for (const b of sample) if (b === 0) nul++;
  if (nul > 4) throw new IngestError('File looks binary, not text');
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

function notebookToText(raw: string): string {
  try {
    const nb = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string[] | string }> };
    return (nb.cells ?? [])
      .map((c) => {
        const src = Array.isArray(c.source) ? c.source.join('') : (c.source ?? '');
        return c.cell_type === 'code' ? '```\n' + src + '\n```' : src;
      })
      .join('\n\n');
  } catch {
    return raw;
  }
}

export async function parseDocument(fileName: string, bytes: Uint8Array): Promise<ParsedDocument> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new IngestError(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  if (bytes.byteLength === 0) throw new IngestError('File is empty');
  const kind = supportedExtension(fileName);
  const title = fileName.replace(/\.[^.]+$/, '');
  switch (kind) {
    case 'pdf': {
      const { extractText, getDocumentProxy } = await import('unpdf');
      let pdf;
      try {
        pdf = await getDocumentProxy(new Uint8Array(bytes));
      } catch (err) {
        throw new IngestError(`Could not open PDF: ${(err as Error).message}`);
      }
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const pages = (text as string[]).map((t, i) => ({ page: i + 1, text: cleanText(t) }));
      const chars = pages.reduce((n, p) => n + p.text.trim().length, 0);
      if (chars < 20) {
        throw new IngestError(
          'No extractable text found — this PDF is probably scanned images. OCR is not bundled; export a text PDF or paste the text as a .txt file.',
        );
      }
      return { mime: 'application/pdf', pages, pageCount: totalPages, title };
    }
    case 'docx': {
      const mammoth = await import('mammoth');
      const extract = (mammoth as unknown as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> }).extractRawText
        ?? (mammoth as unknown as { default: { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> } }).default.extractRawText;
      let value: string;
      try {
        value = (await extract({ buffer: Buffer.from(bytes) })).value;
      } catch (err) {
        throw new IngestError(`Could not read DOCX: ${(err as Error).message}`);
      }
      return {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        pages: [{ page: null, text: cleanText(value) }],
        pageCount: null,
        title,
      };
    }
    case 'text':
    case 'code': {
      let text = decodeText(bytes);
      if (fileName.toLowerCase().endsWith('.ipynb')) text = notebookToText(text);
      if (kind === 'code') text = '```' + extname(fileName).slice(1) + '\n' + text + '\n```';
      return { mime: kind === 'code' ? 'text/x-code' : 'text/plain', pages: [{ page: null, text: cleanText(text) }], pageCount: null, title };
    }
    case 'image':
      throw new IngestError(
        'Images are not indexed automatically. Use “Screen / image context” in the overlay, which previews the image and asks before sending it to a vision model.',
      );
    default:
      throw new IngestError('Unsupported file type. Supported: PDF, DOCX, TXT, MD, CSV, JSON and common code files.');
  }
}
