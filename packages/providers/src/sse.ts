export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG semantics for `event`/`data`,
 * CRLF/LF tolerant, multi-line data joined with '\n').
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | null = null;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buffer.slice(0, idx);
      const nl = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1;
      // A lone trailing '\r' might be the first half of '\r\n': wait for more data.
      if (this.buffer[idx] === '\r' && idx + 1 === this.buffer.length) break;
      this.buffer = this.buffer.slice(idx + nl);
      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({ event: this.eventName, data: this.dataLines.join('\n') });
        }
        this.dataLines = [];
        this.eventName = null;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.dataLines.push(value);
      else if (field === 'event') this.eventName = value;
    }
    return out;
  }

  flush(): SseEvent[] {
    const out = this.push('\n\n');
    return out;
  }
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.push(decoder.decode())) yield ev;
    for (const ev of parser.flush()) yield ev;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
}
