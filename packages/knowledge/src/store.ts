import { createHash } from 'node:crypto';
import type { DocKind, DocumentSummary, ProjectCard, PersonalProfile, SessionProfile } from '@doing/contracts';
import { PersonalProfileSchema, ProjectCardSchema, SessionProfileSchema } from '@doing/contracts';
import { chunkPages } from './chunk';
import type { SqlDatabase } from './db';
import { newId, tx } from './db';
import { parseDocument, IngestError, MAX_DOC_CHARS } from './parse';

interface DocRow {
  id: string;
  title: string;
  file_name: string;
  kind: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  page_count: number | null;
  char_count: number;
  created_at: number;
  modified_at: number | null;
  status: string;
  error: string | null;
  profile_id: string | null;
  embedded_model: string | null;
  chunk_count?: number;
}

export interface IngestOutcome {
  ok: boolean;
  documentId: string | null;
  duplicateOf: string | null;
  error: string | null;
  chunks: number;
  ms: number;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  page: number | null;
  section: string | null;
  text: string;
}

const CARD_DOC_PREFIX = 'card_';
const PROFILE_DOC_ID = 'profile_personal';

function rowToSummary(r: DocRow): DocumentSummary {
  return {
    id: r.id,
    title: r.title,
    fileName: r.file_name,
    kind: r.kind as DocKind,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    pageCount: r.page_count,
    chunkCount: r.chunk_count ?? 0,
    charCount: r.char_count,
    createdAt: r.created_at,
    modifiedAt: r.modified_at,
    status: r.status === 'error' ? 'error' : 'indexed',
    error: r.error,
    embedded: !!r.embedded_model,
    profileId: r.profile_id,
  };
}

/** Owns documents, chunks, the FTS index, embeddings, personal profile and project cards. */
export class KnowledgeStore {
  /** Bumped on every mutation so retrievers can invalidate caches. */
  version = 0;

  constructor(readonly db: SqlDatabase) {}

  listDocuments(includeSynthetic = false): DocumentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count
         FROM documents d ORDER BY d.created_at DESC`,
      )
      .all() as DocRow[];
    return rows
      .filter((r) => includeSynthetic || !(r.id.startsWith(CARD_DOC_PREFIX) || r.id === PROFILE_DOC_ID))
      .map(rowToSummary);
  }

  getDocument(id: string): DocumentSummary | null {
    const r = this.db
      .prepare(`SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunk_count FROM documents d WHERE id = ?`)
      .get(id) as DocRow | undefined;
    return r ? rowToSummary(r) : null;
  }

  getChunks(documentId: string): ChunkRow[] {
    return this.db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal').all(documentId) as ChunkRow[];
  }

  async ingest(fileName: string, bytes: Uint8Array, kind: DocKind, modifiedAt: number | null = null): Promise<IngestOutcome> {
    const t0 = performance.now();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dup = this.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha) as { id: string } | undefined;
    if (dup) {
      return { ok: true, documentId: dup.id, duplicateOf: dup.id, error: null, chunks: 0, ms: performance.now() - t0 };
    }
    let parsed;
    try {
      parsed = await parseDocument(fileName, bytes);
    } catch (err) {
      const msg = err instanceof IngestError ? err.message : `Parser error: ${(err as Error).message}`;
      return { ok: false, documentId: null, duplicateOf: null, error: msg, chunks: 0, ms: performance.now() - t0 };
    }
    let totalChars = 0;
    const pages = parsed.pages.map((p) => {
      const remaining = Math.max(0, MAX_DOC_CHARS - totalChars);
      const text = p.text.slice(0, remaining);
      totalChars += text.length;
      return { ...p, text };
    });
    const chunks = chunkPages(pages);
    if (chunks.length === 0) {
      return { ok: false, documentId: null, duplicateOf: null, error: 'No usable text found in file', chunks: 0, ms: performance.now() - t0 };
    }
    const id = newId('doc');
    this.writeDocument(id, {
      title: parsed.title,
      fileName,
      kind,
      mime: parsed.mime,
      sizeBytes: bytes.byteLength,
      sha256: sha,
      pageCount: parsed.pageCount,
      charCount: totalChars,
      modifiedAt,
      chunks,
    });
    return { ok: true, documentId: id, duplicateOf: null, error: null, chunks: chunks.length, ms: performance.now() - t0 };
  }

  private writeDocument(
    id: string,
    d: {
      title: string;
      fileName: string;
      kind: DocKind;
      mime: string;
      sizeBytes: number;
      sha256: string;
      pageCount: number | null;
      charCount: number;
      modifiedAt: number | null;
      chunks: Array<{ ordinal: number; page: number | null; section: string | null; text: string }>;
    },
  ): void {
    tx(this.db, () => {
      this.deleteDocumentRows(id);
      this.db
        .prepare(
          `INSERT INTO documents(id,title,file_name,kind,mime,size_bytes,sha256,page_count,char_count,created_at,modified_at,status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'indexed')`,
        )
        .run(id, d.title, d.fileName, d.kind, d.mime, d.sizeBytes, d.sha256, d.pageCount, d.charCount, Date.now(), d.modifiedAt);
      const insChunk = this.db.prepare('INSERT INTO chunks(id,document_id,ordinal,page,section,text) VALUES (?,?,?,?,?,?)');
      const insFts = this.db.prepare('INSERT INTO chunks_fts(chunk_id,text,title,section) VALUES (?,?,?,?)');
      for (const c of d.chunks) {
        const cid = `${id}:${c.ordinal}`;
        insChunk.run(cid, id, c.ordinal, c.page, c.section, c.text);
        insFts.run(cid, c.text, d.title, c.section ?? '');
      }
    });
    this.version++;
  }

  private deleteDocumentRows(id: string): void {
    this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(id);
    this.db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(id);
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }

  /** Removes the document, every extracted chunk, its FTS rows and embeddings. Originals are never copied. */
  deleteDocument(id: string): boolean {
    const exists = this.db.prepare('SELECT 1 AS x FROM documents WHERE id = ?').get(id);
    if (!exists) return false;
    tx(this.db, () => this.deleteDocumentRows(id));
    this.version++;
    return true;
  }

  setKind(id: string, kind: DocKind): boolean {
    const r = this.db.prepare('UPDATE documents SET kind = ? WHERE id = ?').run(kind, id);
    this.version++;
    return Number(r.changes) > 0;
  }

  /** Raw text ingestion (job descriptions, notes pasted in the UI). */
  ingestText(id: string, title: string, kind: DocKind, text: string, fileName = '(entered text)'): number {
    const chunks = chunkPages([{ page: null, text }]);
    if (chunks.length === 0) {
      if (this.db.prepare('SELECT 1 AS x FROM documents WHERE id = ?').get(id)) this.deleteDocument(id);
      return 0;
    }
    this.writeDocument(id, {
      title,
      fileName,
      kind,
      mime: 'text/plain',
      sizeBytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(`${id}\n${text}`).digest('hex'),
      pageCount: null,
      charCount: text.length,
      modifiedAt: Date.now(),
      chunks,
    });
    return chunks.length;
  }

  // ─────────────── embeddings ───────────────

  chunksMissingEmbeddings(model: string, limit = 5000): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
         WHERE e.chunk_id IS NULL ORDER BY c.document_id, c.ordinal LIMIT ?`,
      )
      .all(model, limit) as ChunkRow[];
  }

  saveEmbeddings(model: string, items: Array<{ chunkId: string; vector: Float32Array }>): void {
    tx(this.db, () => {
      const ins = this.db.prepare('INSERT OR REPLACE INTO embeddings(chunk_id, model, dims, vector) VALUES (?,?,?,?)');
      for (const it of items) ins.run(it.chunkId, model, it.vector.length, Buffer.from(it.vector.buffer, it.vector.byteOffset, it.vector.byteLength));
      this.db
        .prepare(
          `UPDATE documents SET embedded_model = ? WHERE id IN (SELECT DISTINCT document_id FROM chunks WHERE id IN (${items.map(() => '?').join(',') || "''"}))`,
        )
        .run(model, ...items.map((i) => i.chunkId));
    });
    this.version++;
  }

  loadEmbeddings(model: string): Map<string, Float32Array> {
    const rows = this.db.prepare('SELECT chunk_id, vector FROM embeddings WHERE model = ?').all(model) as Array<{ chunk_id: string; vector: Uint8Array }>;
    const map = new Map<string, Float32Array>();
    for (const r of rows) {
      const bytes = new Uint8Array(r.vector);
      map.set(r.chunk_id, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    }
    return map;
  }

  // ─────────────── personal profile & project cards ───────────────

  getProfile(): PersonalProfile {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = 'personal_profile'").get() as { value: string } | undefined;
    return PersonalProfileSchema.parse(r ? JSON.parse(r.value) : {});
  }

  setProfile(p: PersonalProfile): PersonalProfile {
    const valid = PersonalProfileSchema.parse(p);
    this.db.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('personal_profile', ?)").run(JSON.stringify(valid));
    const text = [
      valid.fullName && `Name: ${valid.fullName}`,
      valid.headline && `Headline: ${valid.headline}`,
      valid.summary && `Summary: ${valid.summary}`,
      valid.skills.length ? `Skills: ${valid.skills.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.ingestText(PROFILE_DOC_ID, 'Personal profile', 'resume', text, '(personal profile)');
    return valid;
  }

  listCards(): ProjectCard[] {
    const rows = this.db.prepare('SELECT json FROM project_cards ORDER BY updated_at DESC').all() as Array<{ json: string }>;
    return rows.map((r) => ProjectCardSchema.parse(JSON.parse(r.json)));
  }

  upsertCard(card: ProjectCard): ProjectCard[] {
    const c = ProjectCardSchema.parse({ ...card, id: card.id || newId('card'), updatedAt: Date.now() });
    this.db.prepare('INSERT OR REPLACE INTO project_cards(id, json, updated_at) VALUES (?,?,?)').run(c.id, JSON.stringify(c), c.updatedAt);
    const docId = CARD_DOC_PREFIX + c.id;
    if (c.visibility === 'private') {
      this.deleteDocument(docId);
    } else {
      this.ingestText(docId, `Project: ${c.title}`, 'project', renderCard(c), '(project card)');
    }
    return this.listCards();
  }

  deleteCard(id: string): ProjectCard[] {
    this.db.prepare('DELETE FROM project_cards WHERE id = ?').run(id);
    this.deleteDocument(CARD_DOC_PREFIX + id);
    return this.listCards();
  }

  // ─────────────── session (company / job) profiles ───────────────

  listSessionProfiles(): SessionProfile[] {
    const rows = this.db.prepare('SELECT json FROM session_profiles ORDER BY updated_at DESC').all() as Array<{ json: string }>;
    return rows.map((r) => SessionProfileSchema.parse(JSON.parse(r.json)));
  }

  getSessionProfile(id: string | null): SessionProfile | null {
    if (!id) return null;
    const r = this.db.prepare('SELECT json FROM session_profiles WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? SessionProfileSchema.parse(JSON.parse(r.json)) : null;
  }

  upsertSessionProfile(p: SessionProfile): SessionProfile[] {
    const v = SessionProfileSchema.parse({ ...p, id: p.id || newId('prof'), updatedAt: Date.now() });
    this.db.prepare('INSERT OR REPLACE INTO session_profiles(id, json, updated_at) VALUES (?,?,?)').run(v.id, JSON.stringify(v), v.updatedAt);
    // Job description and company notes become retrievable company/job evidence.
    this.ingestText(`jd_${v.id}`, `${v.company || v.name} — job description`, 'job_description', v.jobDescription, '(job description)');
    this.ingestText(`co_${v.id}`, `${v.company || v.name} — company notes`, 'company', v.companyNotes, '(company notes)');
    return this.listSessionProfiles();
  }

  deleteSessionProfile(id: string): SessionProfile[] {
    this.db.prepare('DELETE FROM session_profiles WHERE id = ?').run(id);
    this.deleteDocument(`jd_${id}`);
    this.deleteDocument(`co_${id}`);
    return this.listSessionProfiles();
  }

  stats(): { documents: number; chunks: number; embedded: number } {
    const d = this.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };
    const c = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    const e = this.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number };
    return { documents: Number(d.n), chunks: Number(c.n), embedded: Number(e.n) };
  }
}

export function renderCard(c: ProjectCard): string {
  const lines = [
    `Project: ${c.title}`,
    c.role && `My role: ${c.role}`,
    c.technologies.length ? `Technologies: ${c.technologies.join(', ')}` : '',
    c.outcomes && `Measurable outcomes: ${c.outcomes}`,
    c.evidence && `Evidence: ${c.evidence}`,
    c.star.situation && `Situation: ${c.star.situation}`,
    c.star.task && `Task: ${c.star.task}`,
    c.star.action && `Action: ${c.star.action}`,
    c.star.result && `Result: ${c.star.result}`,
  ];
  return lines.filter(Boolean).join('\n');
}
