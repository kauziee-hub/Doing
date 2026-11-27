import type { AudioSource, SpeakerRole, TranscriptSegment } from '@doing/contracts';
import { analyzeQuestion } from './question';

/** Providers sometimes glue sentences together ("thread?You"): restore the missing space. */
export function normalizeSpacing(s: string): string {
  return s.replace(/([.?!])([A-ZÀ-ɏ])/g, '$1 $2');
}

function join(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (!x) return y;
  if (!y) return x;
  return `${x} ${y}`;
}

let counter = 0;
export function segmentId(source: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${source}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

interface Current {
  id: string;
  committed: string;
  interim: string;
  startedAt: number;
  lastUpdateAt: number;
  role?: TranscriptSegment['role'];
}

/**
 * Turns provider interim/final/utterance-end callbacks into stable transcript
 * segments for one audio source. Each segment is either in progress
 * (final=false, text may change) or finalized exactly once.
 */
export class TranscriptAssembler {
  private current: Current | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: AudioSource,
    private readonly emit: (seg: TranscriptSegment) => void,
    private readonly onFinal: (seg: TranscriptSegment) => void,
    private readonly now: () => number = Date.now,
    /** Finalize automatically when a provider never signals utterance end. */
    private readonly idleFinalizeMs = 2500,
    private readonly role: SpeakerRole | null = null,
  ) {}

  private ensure(): Current {
    if (!this.current) {
      const t = this.now();
      this.current = { id: segmentId(this.source), committed: '', interim: '', startedAt: t, lastUpdateAt: t };
    }
    return this.current;
  }

  private publish(): void {
    const c = this.current;
    if (!c) return;
    this.emit({
      id: c.id,
      source: this.source,
      text: join(c.committed, c.interim),
      final: false,
      startedAt: c.startedAt,
      endedAt: null,
      isQuestion: false,
      questionScore: 0,
      role: this.role ?? undefined,
      committedText: c.committed || undefined,
      tentativeText: c.interim || undefined,
    });
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalize(), this.idleFinalizeMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  interim(text: string): void {
    if (!text.trim() && !this.current) return;
    const c = this.ensure();
    c.interim = text;
    c.lastUpdateAt = this.now();
    this.publish();
  }

  /** Streaming path: stable prefix + grey tail. Prefetch should use `committed` only. */
  live(committed: string, tentative: string): void {
    if (!committed.trim() && !tentative.trim() && !this.current) return;
    const c = this.ensure();
    c.committed = committed;
    c.interim = tentative;
    c.lastUpdateAt = this.now();
    this.publish();
  }

  finalSegment(text: string): void {
    if (!text.trim()) return;
    const c = this.ensure();
    c.committed = join(c.committed, text);
    c.interim = '';
    c.lastUpdateAt = this.now();
    this.publish();
  }

  /** Close the utterance in progress. Returns the finalized segment, if any text existed. */
  finalize(): TranscriptSegment | null {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const c = this.current;
    this.current = null;
    if (!c) return null;
    // Interim text is cleared whenever a final segment lands, so anything left is
    // speech the provider had not yet locked: keep it rather than lose words.
    const text = normalizeSpacing(join(c.committed, c.interim));
    if (!text) return null;
    const q = analyzeQuestion(text);
    const seg: TranscriptSegment = {
      id: c.id,
      source: this.source,
      text,
      final: true,
      startedAt: c.startedAt,
      endedAt: this.now(),
      isQuestion: q.isQuestion,
      questionScore: q.score,
      role: this.role ?? undefined,
      committedText: text,
      tentativeText: '',
    };
    this.emit(seg);
    this.onFinal(seg);
    return seg;
  }

  get inProgressText(): string {
    return this.current ? join(this.current.committed, this.current.interim) : '';
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.current = null;
  }
}
