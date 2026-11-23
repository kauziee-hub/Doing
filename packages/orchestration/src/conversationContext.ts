export type SpeakerRole = 'interviewer' | 'me' | 'unknown';

export interface ConversationTurn {
  role: SpeakerRole;
  text: string;
  ts: number;
}

const MAX_TURNS = 16;
/** ~600 tokens at ~4 chars/token. */
export const CONVERSATION_CHAR_CAP = 2400;

export class ConversationContext {
  private readonly turns: ConversationTurn[] = [];

  push(turn: ConversationTurn): void {
    const text = turn.text.trim();
    if (!text) return;
    this.turns.push({ ...turn, text });
    while (this.turns.length > MAX_TURNS) this.turns.shift();
    this.dropOldestUntilCap();
  }

  recent(n = 8): ConversationTurn[] {
    return this.turns.slice(-n);
  }

  /** Last 4 exchanges as prompt text, oldest dropped first to stay under the cap. */
  promptBlock(maxChars = CONVERSATION_CHAR_CAP): string {
    const label = (r: SpeakerRole) => (r === 'me' ? 'Me' : r === 'interviewer' ? 'Interviewer' : 'Unknown');
    const lines = this.turns.map((t) => `${label(t.role)}: ${t.text}`);
    while (lines.length && lines.join('\n').length > maxChars) lines.shift();
    const body = lines.slice(-8).join('\n');
    return body;
  }

  clear(): void {
    this.turns.length = 0;
  }

  private dropOldestUntilCap(): void {
    while (this.turns.length && this.promptBlock().length > CONVERSATION_CHAR_CAP) this.turns.shift();
  }
}

export function tokenOverlap(a: string, b: string): number {
  const A = new Set(
    a
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
  const B = new Set(
    b
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Mic line that is mostly a copy of recent system audio (no headphones). */
export function isEchoBleed(micText: string, systemText: string, micTs: number, systemTs: number, windowMs = 1500): boolean {
  if (Math.abs(micTs - systemTs) > windowMs) return false;
  return tokenOverlap(micText, systemText) > 0.8;
}

export function roleForSource(source: 'mic' | 'system' | 'app' | 'typed', captureMode: 'two-stream' | 'single-mic'): SpeakerRole {
  if (captureMode === 'single-mic') return 'unknown';
  if (source === 'mic') return 'me';
  if (source === 'typed') return 'unknown';
  return 'interviewer';
}
