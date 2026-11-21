/**
 * Lightweight secret detector used before any user-provided text (clipboard,
 * typed context, workspace files) is sent to a model provider. It is a
 * best-effort guard, not a DLP product: findings are shown to the user, who
 * decides whether to send redacted or original text.
 */
export interface SecretMatch {
  kind: string;
  start: number;
  end: number;
  preview: string;
}

const PATTERNS: Array<{ kind: string; re: RegExp; group?: number }> = [
  { kind: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Google API key (AQ. format)', re: /\bAQ\.[A-Za-z0-9_-]{30,}/g },
  { kind: 'xAI API key', re: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { kind: 'OpenAI-style secret key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'Bearer token', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  { kind: 'Credentials in URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gi, group: 1 },
  {
    kind: 'Password / secret assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"'`,;]{6,})/gi,
    group: 1,
  },
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function mask(s: string): string {
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${'•'.repeat(4)}${s.slice(-2)}`;
}

export function detectSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { kind, re, group } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = group !== undefined ? m[group] : m[0];
      if (!value) continue;
      const start = group !== undefined ? m.index + m[0].indexOf(value) : m.index;
      found.push({ kind, start, end: start + value.length, preview: mask(value) });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  // Payment card numbers (13–19 digits, optional spaces/dashes, Luhn-valid).
  const cardRe = /\b(?:\d[ -]?){13,19}\b/g;
  let c: RegExpExecArray | null;
  while ((c = cardRe.exec(text)) !== null) {
    const digits = c[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits) && !/^(\d)\1+$/.test(digits)) {
      found.push({ kind: 'Payment card number', start: c.index, end: c.index + c[0].length, preview: mask(digits) });
    }
  }
  // Merge overlaps, keep the earliest/longest.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretMatch[] = [];
  for (const f of found) {
    const last = merged[merged.length - 1];
    if (last && f.start < last.end) {
      last.end = Math.max(last.end, f.end);
      continue;
    }
    merged.push({ ...f });
  }
  return merged;
}

export function redactSecrets(text: string, matches = detectSecrets(text)): string {
  let out = '';
  let pos = 0;
  for (const m of matches) {
    out += text.slice(pos, m.start) + `[REDACTED ${m.kind}]`;
    pos = m.end;
  }
  return out + text.slice(pos);
}
