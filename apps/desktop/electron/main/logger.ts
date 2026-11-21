import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/g,
  /\bAQ\.[A-Za-z0-9_-]{30,}/g,
  /\b(?:xai|sk)-[A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /([?&]key=)[^&\s"]+/gi,
  /("?(?:api[_-]?key|authorization|x-goog-api-key)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1?: string) => (typeof p1 === 'string' && m.startsWith(p1) ? `${p1}[redacted]` : '[redacted]'));
  return out;
}

/**
 * Metadata-only logger. Never pass transcripts, answers, document text or keys:
 * the redaction pass is a backstop, not a licence to log content.
 */
export class Logger {
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'hirora.log');
  }

  get path(): string {
    return this.file;
  }

  private write(level: string, msg: string, meta?: Record<string, unknown>): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > 5 * 1024 * 1024) {
        renameSync(this.file, `${this.file}.1`);
      }
      const line = `${new Date().toISOString()} ${level} ${redact(msg)}${meta ? ' ' + redact(JSON.stringify(meta)) : ''}\n`;
      appendFileSync(this.file, line, 'utf8');
      if (process.env.HIRORA_LOG_STDOUT) process.stdout.write(line);
    } catch {
      /* logging must never crash the app */
    }
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('INFO', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('WARN', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('ERROR', msg, meta);
  }
}
