/**
 * At most one whisper.cpp request per source. Interim ticks are skipped when their source is
 * busy, and mic ticks also give way to system audio. The decode at the end of a turn waits for
 * its turn instead: skipping it would lose the last words of the question.
 */
export class WhisperLane {
  private readonly busy = new Map<string, Promise<unknown>>();

  get inflight(): string[] {
    return [...this.busy.keys()];
  }

  async run<T>(source: string, priority: 'high' | 'low' | 'final', fn: () => Promise<T>): Promise<T | null> {
    if (priority === 'final') {
      while (this.busy.has(source)) await this.busy.get(source)!.catch(() => undefined);
    } else {
      if (this.busy.has(source)) return null;
      if (priority === 'low' && this.busy.has('system')) return null;
    }
    const p = fn();
    this.busy.set(source, p);
    try {
      return await p;
    } finally {
      if (this.busy.get(source) === p) this.busy.delete(source);
    }
  }
}
