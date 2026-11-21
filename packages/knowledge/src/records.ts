import type {
  AnswerRecord,
  CaptureCheckResult,
  HistorySessionDetail,
  HistorySessionSummary,
  PerfSample,
  PerfStage,
  PerfSummaryRow,
  TranscriptSegment,
} from '@hirora/contracts';
import type { SqlDatabase } from './db';
import { tx } from './db';

/** Opt-in session history. Nothing is written unless the caller decides history is enabled. */
export class HistoryStore {
  constructor(private readonly db: SqlDatabase) {}

  startSession(id: string, mode: string, profileName: string | null): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions(id, started_at, mode, profile_name) VALUES (?,?,?,?)').run(id, Date.now(), mode, profileName);
  }

  endSession(id: string): void {
    const first = this.db
      .prepare("SELECT json FROM segments WHERE session_id = ? ORDER BY at LIMIT 1")
      .get(id) as { json: string } | undefined;
    const title = first ? (JSON.parse(first.json) as TranscriptSegment).text.slice(0, 80) : 'Session';
    this.db.prepare('UPDATE sessions SET ended_at = ?, title = ? WHERE id = ?').run(Date.now(), title, id);
  }

  saveSegment(sessionId: string, seg: TranscriptSegment): void {
    this.db.prepare('INSERT OR REPLACE INTO segments(id, session_id, json, at) VALUES (?,?,?,?)').run(seg.id, sessionId, JSON.stringify(seg), seg.startedAt);
  }

  saveAnswer(sessionId: string, a: AnswerRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO answers(id, session_id, json, at) VALUES (?,?,?,?)').run(a.requestId, sessionId, JSON.stringify(a), a.createdAt);
  }

  list(): HistorySessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS seg_count,
                (SELECT COUNT(*) FROM answers a WHERE a.session_id = s.id) AS ans_count
         FROM sessions s ORDER BY s.started_at DESC LIMIT 500`,
      )
      .all() as Array<{ id: string; started_at: number; ended_at: number | null; mode: string; profile_name: string | null; title: string; seg_count: number; ans_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      mode: r.mode,
      profileName: r.profile_name,
      segmentCount: Number(r.seg_count),
      answerCount: Number(r.ans_count),
      title: r.title || 'Session',
    }));
  }

  get(id: string): HistorySessionDetail | null {
    const s = this.list().find((x) => x.id === id);
    if (!s) return null;
    const segs = this.db.prepare('SELECT json FROM segments WHERE session_id = ? ORDER BY at').all(id) as Array<{ json: string }>;
    const ans = this.db.prepare('SELECT json FROM answers WHERE session_id = ? ORDER BY at').all(id) as Array<{ json: string }>;
    return {
      session: s,
      segments: segs.map((r) => JSON.parse(r.json) as TranscriptSegment),
      answers: ans.map((r) => JSON.parse(r.json) as AnswerRecord),
    };
  }

  delete(id: string): boolean {
    return tx(this.db, () => {
      this.db.prepare('DELETE FROM segments WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM answers WHERE session_id = ?').run(id);
      return Number(this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes) > 0;
    });
  }

  deleteAll(): number {
    return tx(this.db, () => {
      this.db.exec('DELETE FROM segments; DELETE FROM answers;');
      return Number(this.db.prepare('DELETE FROM sessions').run().changes);
    });
  }

  applyRetention(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    const ids = this.db.prepare('SELECT id FROM sessions WHERE started_at < ?').all(cutoff) as Array<{ id: string }>;
    for (const { id } of ids) this.delete(id);
    return ids.length;
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Real measured timings only; nothing here is synthesized. */
export class PerfStore {
  constructor(private readonly db: SqlDatabase) {}

  record(s: PerfSample): void {
    if (!Number.isFinite(s.ms) || s.ms < 0) return;
    this.db.prepare('INSERT INTO perf_events(stage, ms, at, provider, model, label) VALUES (?,?,?,?,?,?)').run(s.stage, s.ms, s.at, s.provider, s.model, s.label);
  }

  summary(sinceMs = 0): PerfSummaryRow[] {
    const rows = this.db
      .prepare('SELECT stage, provider, ms FROM perf_events WHERE at >= ? ORDER BY stage, provider, ms')
      .all(sinceMs) as Array<{ stage: string; provider: string | null; ms: number }>;
    const groups = new Map<string, { stage: string; provider: string | null; values: number[] }>();
    for (const r of rows) {
      const key = `${r.stage}|${r.provider ?? ''}`;
      const g = groups.get(key) ?? { stage: r.stage, provider: r.provider, values: [] };
      g.values.push(r.ms);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => {
      const v = g.values.sort((a, b) => a - b);
      return {
        stage: g.stage as PerfStage,
        provider: g.provider,
        count: v.length,
        p50: percentile(v, 50),
        p95: percentile(v, 95),
        min: v[0]!,
        max: v[v.length - 1]!,
      };
    });
  }

  recent(limit = 100): PerfSample[] {
    return this.db.prepare('SELECT stage, ms, at, provider, model, label FROM perf_events ORDER BY id DESC LIMIT ?').all(limit) as unknown as PerfSample[];
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM perf_events').get() as { n: number }).n);
  }

  clear(): void {
    this.db.exec('DELETE FROM perf_events');
  }
}

export class UsageStore {
  constructor(private readonly db: SqlDatabase) {}

  recordAnswer(provider: string, model: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null): void {
    this.db
      .prepare('INSERT INTO usage_events(at, kind, provider, model, input_tokens, output_tokens, amount, cost_usd) VALUES (?,?,?,?,?,?,?,?)')
      .run(Date.now(), 'answer', provider, model, inputTokens, outputTokens, 1, costUsd);
  }

  recordStt(provider: string, seconds: number): void {
    if (seconds <= 0) return;
    this.db.prepare('INSERT INTO usage_events(at, kind, provider, amount) VALUES (?,?,?,?)').run(Date.now(), 'stt_seconds', provider, seconds);
  }

  today(): { answers: number; sttMinutes: number; costUsd: number | null } {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const a = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'answer' AND at >= ?").get(start.getTime()) as { n: number };
    const s = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS secs FROM usage_events WHERE kind = 'stt_seconds' AND at >= ?").get(start.getTime()) as { secs: number };
    const c = this.db
      .prepare("SELECT SUM(cost_usd) AS c, COUNT(cost_usd) AS n FROM usage_events WHERE at >= ?")
      .get(start.getTime()) as { c: number | null; n: number };
    return { answers: Number(a.n), sttMinutes: Number(s.secs) / 60, costUsd: Number(c.n) > 0 ? Number(c.c) : null };
  }

  monthCostUsd(): number {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const c = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage_events WHERE at >= ?').get(start) as { c: number };
    return Number(c.c);
  }
}

export class CaptureResultStore {
  constructor(private readonly db: SqlDatabase) {}

  add(results: CaptureCheckResult[]): void {
    const ins = this.db.prepare('INSERT INTO capture_results(at, json) VALUES (?,?)');
    for (const r of results) ins.run(r.testedAt, JSON.stringify(r));
  }

  latest(): CaptureCheckResult[] {
    const rows = this.db.prepare('SELECT json FROM capture_results ORDER BY id DESC LIMIT 50').all() as Array<{ json: string }>;
    const seen = new Set<string>();
    const out: CaptureCheckResult[] = [];
    for (const r of rows) {
      const v = JSON.parse(r.json) as CaptureCheckResult;
      const key = `${v.method}|${v.contentProtectionEnabled}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }
}
