/** At most one whisper.cpp request per source; interviewer (system) wins over mic. */
export class WhisperLane {
  private readonly busy = new Set<string>();

  get inflight(): string[] {
    return [...this.busy];
  }

  async run<T>(source: string, priority: 'high' | 'low', fn: () => Promise<T>): Promise<T | null> {
    if (this.busy.has(source)) return null;
    if (priority === 'low' && this.busy.has('system')) return null;
    this.busy.add(source);
    try {
      return await fn();
    } finally {
      this.busy.delete(source);
    }
  }
}
