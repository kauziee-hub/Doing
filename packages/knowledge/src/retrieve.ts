import type { DocKind, RetrievedChunk } from '@hirora/contracts';
import { evidenceClassForKind } from '@hirora/contracts';
import type { KnowledgeStore } from './store';

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does doing for from had has have having he her hers him his how i if in into is it its
   just me my myself no nor not of on or our ours out over own same she should so some such than that the their them then there these they
   this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself
   tell describe explain talk walk please about give us something time could would like know think`
    .split(/\s+/)
    .filter(Boolean),
);

export function queryTerms(q: string): string[] {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.\-_]*/gu) ?? [])
    .map((t) => t.replace(/[.\-_]+$/, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(terms)].slice(0, 24);
}

/** Title words that say what kind of note it is, not what it is about. */
const GENERIC_TITLE_WORDS = new Set('deep dive project projects other notes note talking points basics resume résumé interview company document details overview personal profile technologies technology'.split(' '));

/**
 * Query words that name a document ("Lumen" in "explain how you built Lumen", with a note
 * titled "Lumen - deep dive"). Measured on 2026-11-26: without this, "procedure" (rare, so
 * ranked high) pulled another project's notes and none of the named project's came back. Only
 * notes about the user's own work get the boost; a "Kafka background" note shouldn't outrank
 * the résumé on "your Kafka migration".
 */
export function namesDocument(terms: string[], title: string): boolean {
  const words = new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !GENERIC_TITLE_WORDS.has(w)));
  return terms.some((t) => words.has(t));
}

/** Builds a safe FTS5 MATCH expression: every term quoted, OR-combined. */
export function ftsQuery(q: string): string | null {
  const terms = queryTerms(q);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Questions about the candidate themself. Their résumé is attached even when no word
 * matches ("Please introduce yourself" shares no keywords with a résumé).
 */
export function isAboutTheCandidate(q: string): boolean {
  return /\b(yourself|about you\b|your (?:experience|background|projects?|roles?|resume|résumé|cv|strengths?|weakness(?:es)?|career|education|degree|skills?|team|work|jobs?|internships?|achievements?|last|current|previous|biggest|greatest|favou?rite)|you(?:'ve| have)? (?:worked|built|led|did|handled|faced|used|managed|designed|shipped|learned|done)|about a time|walk me through your|why should we hire|why do you want|where do you see yourself|what makes you|introduce|introduction)\b/i.test(q);
}

/** First-person experience questions should prefer the user's own evidence. */
export function isFirstPersonQuestion(q: string): boolean {
  return /\b(you|your|yourself|tell me about a time|walk me through|have you|did you|what did you|why should we hire)\b/i.test(q);
}

interface Candidate {
  id: string;
  document_id: string;
  ordinal: number;
  page: number | null;
  section: string | null;
  text: string;
  title: string;
  file_name: string;
  kind: string;
}

/** A typical one- or two-page résumé is 6–14 chunks of ~800 characters. */
const RESUME_CHUNKS_FOR_CANDIDATE = 12;

export interface RetrieveOptions {
  topK: number;
  /** Résumé chunks attached to questions about the candidate (default: the whole résumé, up to 12). */
  maxResumeChunks?: number;
  /** Passages from one document (default 3, for variety); a walkthrough of one project takes more. */
  perDocument?: number;
  queryVector?: Float32Array | null;
  embeddingModel?: string | null;
}

export class HybridRetriever {
  private vecCache: { version: number; model: string; vectors: Map<string, Float32Array> } | null = null;

  constructor(private readonly store: KnowledgeStore) {}

  private vectors(model: string): Map<string, Float32Array> {
    if (!this.vecCache || this.vecCache.version !== this.store.version || this.vecCache.model !== model) {
      this.vecCache = { version: this.store.version, model, vectors: this.store.loadEmbeddings(model) };
    }
    return this.vecCache.vectors;
  }

  hasVectors(model: string): boolean {
    return this.vectors(model).size > 0;
  }

  /** Warm caches so the first live query does not pay the load cost. */
  warm(model: string | null): void {
    if (model) this.vectors(model);
    this.store.db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'warm'").get();
  }

  private fetchChunks(ids: string[]): Map<string, Candidate> {
    const map = new Map<string, Candidate>();
    if (ids.length === 0) return map;
    const rows = this.store.db
      .prepare(
        `SELECT c.id, c.document_id, c.ordinal, c.page, c.section, c.text, d.title, d.file_name, d.kind
         FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Candidate[];
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  retrieve(question: string, opts: RetrieveOptions): RetrievedChunk[] {
    const k = Math.max(1, opts.topK);
    const ranked = new Map<string, { score: number; by: Set<'fts' | 'vector' | 'profile'> }>();
    const add = (id: string, rank: number, by: 'fts' | 'vector' | 'profile', weight = 1) => {
      const cur = ranked.get(id) ?? { score: 0, by: new Set() };
      cur.score += weight / (60 + rank);
      cur.by.add(by);
      ranked.set(id, cur);
    };

    const match = ftsQuery(question);
    if (match) {
      const rows = this.store.db
        .prepare(`SELECT chunk_id, bm25(chunks_fts, 0.0, 1.0, 0.6, 0.4) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT 40`)
        .all(match) as Array<{ chunk_id: string; s: number }>;
      rows.forEach((r, i) => add(r.chunk_id, i, 'fts'));
    }

    if (opts.queryVector && opts.embeddingModel) {
      const vecs = this.vectors(opts.embeddingModel);
      const q = opts.queryVector;
      const scored: Array<[string, number]> = [];
      for (const [id, v] of vecs) {
        if (v.length !== q.length) continue;
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += (v[i] ?? 0) * (q[i] ?? 0);
        scored.push([id, dot]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      scored.slice(0, 40).forEach(([id, sim], i) => {
        if (sim > 0.35) add(id, i, 'vector');
      });
    }

    const aboutCandidate = isAboutTheCandidate(question);
    let resumeId: string | null = null;
    if (aboutCandidate) {
      // The whole newest résumé (it is short): keyword search misses "internship" vs "Intern",
      // and the section a question needs is often not near the top.
      const rows = this.store.db
        .prepare(
          `SELECT c.id, c.document_id FROM chunks c
           WHERE c.document_id = (SELECT id FROM documents WHERE kind = 'resume' ORDER BY created_at DESC LIMIT 1)
           ORDER BY c.ordinal ASC LIMIT ${RESUME_CHUNKS_FOR_CANDIDATE}`,
        )
        .all() as Array<{ id: string; document_id: string }>;
      rows.forEach((r, i) => add(r.id, i, 'profile'));
      resumeId = rows[0]?.document_id ?? null;
    }

    if (ranked.size === 0) return [];
    const firstPerson = isFirstPersonQuestion(question);
    const terms = queryTerms(question);
    const chunks = this.fetchChunks([...ranked.keys()]);
    const results: RetrievedChunk[] = [];
    for (const [id, r] of ranked) {
      const c = chunks.get(id);
      if (!c) continue;
      const kind = c.kind as DocKind;
      const evidence = evidenceClassForKind(kind);
      let score = r.score;
      if (firstPerson && evidence === 'my_facts') score *= 1.35;
      if (r.by.size > 1) score *= 1.15;
      if (evidence === 'my_facts' && namesDocument(terms, c.title)) score *= 2;
      results.push({
        chunkId: c.id,
        documentId: c.document_id,
        documentTitle: c.title,
        fileName: c.file_name,
        kind,
        evidence,
        page: c.page,
        section: c.section,
        ordinal: c.ordinal,
        text: c.text,
        score,
        matchedBy: [...r.by],
      });
    }
    results.sort((a, b) => b.score - a.score);
    // Diversity: at most 3 chunks per document (perDocument), except the résumé on questions about the candidate.
    const perDoc = new Map<string, number>();
    const out: RetrievedChunk[] = [];
    const resumeCap = Math.max(1, Math.min(RESUME_CHUNKS_FOR_CANDIDATE, opts.maxResumeChunks ?? RESUME_CHUNKS_FOR_CANDIDATE));
    const limit = resumeId ? Math.max(k, resumeCap + 2) : k;
    for (const r of results) {
      const n = perDoc.get(r.documentId) ?? 0;
      if (n >= (r.documentId === resumeId ? resumeCap : opts.perDocument ?? 3)) continue;
      perDoc.set(r.documentId, n + 1);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}
