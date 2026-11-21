import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FIXTURE_RESUME_PAGES, buildDocx, buildPdf } from '../../../tests/fixtures/builders';
import { chunkPages } from './chunk';
import { migrate } from './db';
import type { SqlDatabase } from './db';
import { HistoryStore, PerfStore, UsageStore, percentile } from './records';
import { HybridRetriever, ftsQuery, isFirstPersonQuestion } from './retrieve';
import { KnowledgeStore } from './store';
import { parseDocument } from './parse';

function freshDb(): SqlDatabase {
  const db = new DatabaseSync(':memory:') as unknown as SqlDatabase;
  migrate(db);
  return db;
}

describe('parsers (real pdf.js / mammoth on synthetic fixtures)', () => {
  it('extracts per-page text from a PDF', async () => {
    const parsed = await parseDocument('resume.pdf', buildPdf(FIXTURE_RESUME_PAGES));
    expect(parsed.pageCount).toBe(2);
    expect(parsed.pages[0]!.text).toContain('Apache Kafka');
    expect(parsed.pages[1]!.text).toContain('Lakeside University');
  });

  it('extracts text from DOCX', async () => {
    const parsed = await parseDocument('notes.docx', buildDocx(['Project Atlas notes (FIXTURE)', 'Cut cloud spend by 18 percent.']));
    expect(parsed.pages[0]!.text).toContain('Cut cloud spend by 18 percent');
  });

  it('rejects binary masquerading as text, empty files, images and unknown types', async () => {
    await expect(parseDocument('x.txt', new Uint8Array([0, 0, 0, 0, 0, 0, 65]))).rejects.toThrow(/binary/);
    await expect(parseDocument('x.txt', new Uint8Array())).rejects.toThrow(/empty/);
    await expect(parseDocument('x.png', new Uint8Array([1, 2]))).rejects.toThrow(/Images are not indexed/);
    await expect(parseDocument('x.exe', new Uint8Array([1, 2]))).rejects.toThrow(/Unsupported/);
  });
});

describe('chunker', () => {
  it('keeps page provenance, headings and dedupes identical chunks', () => {
    const text = '# Experience\n\n' + 'Built a payments ledger. '.repeat(60) + '\n\n# Education\n\nBSc.';
    const chunks = chunkPages([{ page: 3, text }, { page: 4, text }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1600)).toBe(true);
    expect(chunks[0]!.page).toBe(3);
    expect(chunks[0]!.section).toBe('Experience');
    const texts = chunks.map((c) => c.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('KnowledgeStore + HybridRetriever', () => {
  it('ingests, dedupes, retrieves with source trace, and deletes everything', async () => {
    const db = freshDb();
    const store = new KnowledgeStore(db);
    const pdf = buildPdf(FIXTURE_RESUME_PAGES);
    const r1 = await store.ingest('resume.pdf', pdf, 'resume');
    expect(r1.ok).toBe(true);
    const dup = await store.ingest('copy-of-resume.pdf', pdf, 'resume');
    expect(dup.duplicateOf).toBe(r1.documentId);
    store.ingestText('notes1', 'Kafka background', 'notes', 'Apache Kafka is a distributed event streaming platform used for pipelines.');

    const retriever = new HybridRetriever(store);
    const hits = retriever.retrieve('Tell me about your Kafka migration and its impact', { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.evidence).toBe('my_facts'); // first-person question prefers the resume
    expect(top.fileName).toBe('resume.pdf');
    expect(top.page).toBe(1);
    expect(top.text).toContain('6 hours to 15 minutes');

    expect(retriever.retrieve('quantum chromodynamics lattice', { topK: 3 })).toEqual([]);

    // Questions about the candidate get the résumé even with no shared keywords.
    for (const q of ['Please introduce yourself.', 'Can you tell me about a challenging project you worked on?', 'Hello, give me a brief introduction about yourself.']) {
      const about = retriever.retrieve(q, { topK: 3 });
      expect(about.length, q).toBeGreaterThan(0);
      expect(about[0]!.fileName, q).toBe('resume.pdf');
      expect(about[0]!.matchedBy, q).toContain('profile');
    }
    // The whole (short) résumé comes along, not just its top: the needed section may be anywhere.
    const resumeChunks = store.getChunks(r1.documentId!).length;
    const all = retriever.retrieve('so in your last internship what tech stack did you use', { topK: 3 });
    expect(all.filter((h) => h.fileName === 'resume.pdf').length).toBe(Math.min(resumeChunks, 12));
    // …but not general/technical ones.
    expect(retriever.retrieve('What is the difference between a process and a thread?', { topK: 3 }).some((h) => h.matchedBy.includes('profile'))).toBe(false);

    const docId = r1.documentId!;
    store.saveEmbeddings('test-model', store.getChunks(docId).map((c) => ({ chunkId: c.id, vector: new Float32Array([1, 0, 0]) })));
    expect(store.stats().embedded).toBeGreaterThan(0);
    expect(store.deleteDocument(docId)).toBe(true);
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM chunks WHERE document_id = ?) AS c, (SELECT COUNT(*) FROM chunks_fts WHERE chunk_id LIKE ?) AS f, (SELECT COUNT(*) FROM embeddings) AS e`).get(docId, `${docId}:%`) as { c: number; f: number; e: number };
    expect(counts).toEqual({ c: 0, f: 0, e: 0 });
    expect(retriever.retrieve('Kafka migration batch latency', { topK: 3 }).every((h) => h.documentId !== docId)).toBe(true);
  });

  it('fuses vector and keyword rankings', () => {
    const store = new KnowledgeStore(freshDb());
    store.ingestText('a', 'Doc A', 'notes', 'Rate limiting with token buckets protects public APIs from abuse and bursts.');
    store.ingestText('b', 'Doc B', 'notes', 'Our team celebrated the quarterly launch with a picnic by the river.');
    const vec = (x: number[]) => new Float32Array(x);
    store.saveEmbeddings('m', [
      { chunkId: 'a:0', vector: vec([1, 0]) },
      { chunkId: 'b:0', vector: vec([0, 1]) },
    ]);
    const r = new HybridRetriever(store).retrieve('how to throttle requests', { topK: 2, queryVector: vec([0.95, 0.31]), embeddingModel: 'm' });
    expect(r[0]!.documentId).toBe('a');
    expect(r[0]!.matchedBy).toContain('vector');
  });

  it('treats hostile query text as literal search terms', () => {
    expect(ftsQuery('"); DROP TABLE chunks; -- NEAR(a b) OR *')).toBe('"drop" OR "table" OR "chunks" OR "near"');
    const store = new KnowledgeStore(freshDb());
    store.ingestText('a', 'Doc', 'notes', 'Tables are dropped carefully near production.');
    expect(() => new HybridRetriever(store).retrieve('"); DROP TABLE chunks; -- NEAR(a b)', { topK: 3 })).not.toThrow();
    expect(store.stats().chunks).toBe(1);
  });

  it('project cards are indexed as my_facts and private cards are not', () => {
    const store = new KnowledgeStore(freshDb());
    store.upsertCard({ id: 'c1', title: 'Search revamp', role: 'Tech lead', technologies: ['Elasticsearch'], outcomes: 'p95 latency down 40%', evidence: '', star: { situation: '', task: '', action: '', result: '' }, visibility: 'use_in_answers', updatedAt: 0 });
    store.upsertCard({ id: 'c2', title: 'Secret skunkworks', role: '', technologies: [], outcomes: 'classified', evidence: '', star: { situation: '', task: '', action: '', result: '' }, visibility: 'private', updatedAt: 0 });
    const r = new HybridRetriever(store);
    expect(r.retrieve('Elasticsearch latency project', { topK: 3 })[0]?.evidence).toBe('my_facts');
    expect(r.retrieve('skunkworks classified', { topK: 3 })).toEqual([]);
    expect(isFirstPersonQuestion('Tell me about a time you failed')).toBe(true);
  });
});

describe('records', () => {
  it('history is per-session and fully deletable', () => {
    const h = new HistoryStore(freshDb());
    h.startSession('s1', 'coding', null);
    h.saveSegment('s1', { id: 'g1', source: 'system', text: 'What is a heap?', final: true, startedAt: 1, endedAt: 2, isQuestion: true, questionScore: 0.9 });
    h.endSession('s1');
    expect(h.list()[0]).toMatchObject({ id: 's1', segmentCount: 1, title: 'What is a heap?' });
    expect(h.deleteAll()).toBe(1);
    expect(h.list()).toEqual([]);
  });

  it('perf percentiles and usage counters', () => {
    const db = freshDb();
    const p = new PerfStore(db);
    for (const ms of [100, 200, 300, 400, 1000]) p.record({ stage: 'request_to_first_token', ms, at: Date.now(), provider: 'gemini', model: 'm', label: null });
    p.record({ stage: 'retrieval', ms: -5, at: Date.now(), provider: null, model: null, label: null }); // ignored
    const row = p.summary().find((r) => r.stage === 'request_to_first_token')!;
    expect(row).toMatchObject({ count: 5, p50: 300, p95: 1000, min: 100, max: 1000 });
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    const u = new UsageStore(db);
    u.recordAnswer('gemini', 'm', 10, 5, null);
    u.recordStt('gemini-live', 90);
    expect(u.today()).toEqual({ answers: 1, sttMinutes: 1.5, costUsd: null });
  });
});
