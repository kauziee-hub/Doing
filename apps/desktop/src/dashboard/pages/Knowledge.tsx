import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import { FileText, Search, Trash2, Upload, Eye } from 'lucide-react';
import type { DocKind, DocumentPreview, DocumentSummary, IngestResult, RetrievedChunk } from '@hirora/contracts';
import { DOC_KINDS } from '@hirora/contracts';
import { Badge, Button, Card, EmptyState, Toggle, cx } from '@hirora/ui';
import { invoke, pathForFile } from '../../shared/api';
import { PageHeader } from '../App';
import { useLive } from '../../shared/store';

const KIND_LABEL: Record<DocKind, string> = {
  resume: 'Resume / CV (my facts)',
  project: 'Project notes (my facts)',
  job_description: 'Job description',
  company: 'Company research',
  notes: 'Notes / background',
  code: 'Code',
  other: 'Other',
};

function fmtBytes(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function Knowledge() {
  const settings = useLive((s) => s.settings);
  const setSettings = useLive((s) => s.setSettings);
  const toast = useLive((s) => s.toast);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [kind, setKind] = useState<DocKind>('resume');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<IngestResult[]>([]);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ results: RetrievedChunk[]; ms: number; usedVectors: boolean } | null>(null);

  const refresh = async () => setDocs(await invoke('knowledge:list'));
  useEffect(() => {
    void refresh();
  }, []);

  const handle = async (p: Promise<IngestResult[]>) => {
    setBusy(true);
    try {
      const r = await p;
      setResults(r);
      await refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map((f) => pathForFile(f)).filter(Boolean);
    if (paths.length) void handle(invoke('knowledge:ingestPaths', { kind, paths }));
  };

  return (
    <>
      <PageHeader light="Your" bold="knowledge" sub="Parsed and indexed on this PC. Only the passages relevant to a question are sent to your model — as data, never as instructions. Deleting removes the text, index and embeddings." />
      <Card title="Add documents">
        <div className="vc-row" style={{ marginBottom: 12 }}>
          <label className="vc-field__label" htmlFor="kind">This upload is</label>
          <select id="kind" className="vc-select" style={{ width: 260 }} value={kind} onChange={(e) => setKind(e.target.value as DocKind)}>
            {DOC_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <Button variant="primary" icon={<Upload size={14} />} disabled={busy} onClick={() => void handle(invoke('knowledge:pickFiles', { kind }))}>{busy ? 'Indexing…' : 'Choose files'}</Button>
        </div>
        <div className={cx('dash-drop', over && 'is-over')} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          Drop PDF, DOCX, TXT, MD, CSV, JSON or code files here (max 25 MB each). Scanned PDFs need OCR first; images are only used via the overlay’s screenshot flow.
        </div>
        {results.length ? (
          <ul className="dash-small" style={{ marginBottom: 0 }}>
            {results.map((r) => (
              <li key={r.fileName + r.ms}>
                {r.fileName}: {r.ok ? (r.duplicateOf ? 'already indexed (duplicate content)' : `indexed ${r.chunks} chunks in ${r.ms} ms`) : <span style={{ color: 'var(--error)' }}>{r.error}</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title={`Documents (${docs.length})`}>
        {docs.length === 0 ? (
          <EmptyState icon={<FileText size={28} />} title="No documents yet">Add your resume first: Hirora then refuses to invent personal facts that are not in it.</EmptyState>
        ) : (
          <table className="dash-table">
            <thead><tr><th>Document</th><th>Type</th><th className="dash-num">Pages</th><th className="dash-num">Chunks</th><th className="dash-num">Size</th><th>Index</th><th /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong><div className="dash-small">{d.fileName} · added {new Date(d.createdAt).toLocaleDateString()}</div></td>
                  <td>
                    <select className="vc-select" value={d.kind} aria-label={`Type of ${d.title}`} onChange={async (e) => { await invoke('knowledge:setKind', { documentId: d.id, kind: e.target.value as DocKind }); await refresh(); }}>
                      {DOC_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                  </td>
                  <td className="dash-num">{d.pageCount ?? '—'}</td>
                  <td className="dash-num">{d.chunkCount}</td>
                  <td className="dash-num">{fmtBytes(d.sizeBytes)}</td>
                  <td>{d.embedded ? <Badge tone="ok">FTS + vectors</Badge> : <Badge>FTS</Badge>}</td>
                  <td>
                    <div className="vc-row" style={{ flexWrap: 'nowrap' }}>
                      <Button size="sm" variant="ghost" icon={<Eye size={13} />} aria-label={`Preview ${d.title}`} onClick={async () => setPreview(await invoke('knowledge:preview', { documentId: d.id }))} />
                      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Delete ${d.title}`} onClick={async () => { if (confirm(`Delete “${d.title}” and all of its indexed text?`)) { await invoke('knowledge:delete', { documentId: d.id }); await refresh(); } }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="dash-cols">
        <Card title="Test retrieval">
          <form className="vc-row" onSubmit={async (e) => { e.preventDefault(); if (query.trim()) setHits(await invoke('knowledge:search', { query })); }}>
            <input className="vc-input" style={{ flex: 1 }} placeholder="e.g. Tell me about a time you led a migration" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Retrieval test query" />
            <Button type="submit" icon={<Search size={14} />}>Search</Button>
          </form>
          {hits ? (
            <div style={{ marginTop: 12 }}>
              <div className="dash-small">{hits.results.length} passages in {hits.ms} ms {hits.usedVectors ? '(FTS + vectors)' : '(FTS only)'}</div>
              {hits.results.map((h, i) => (
                <div key={h.chunkId} className="dash-chunk">
                  <div className="dash-chunk__meta">S{i + 1} · {h.documentTitle}{h.page ? ` p.${h.page}` : ''} · {h.evidence} · {h.matchedBy.join('+')} · score {h.score.toFixed(4)}</div>
                  {h.text.slice(0, 500)}{h.text.length > 500 ? '…' : ''}
                </div>
              ))}
            </div>
          ) : null}
        </Card>
        <Card title="Semantic search (optional)">
          {settings ? (
            <>
              <Toggle
                checked={settings.knowledge.useEmbeddings}
                label="Use Gemini embeddings for hybrid retrieval"
                description={`Sends document chunks to Google (${settings.knowledge.embeddingModel}) once to create vectors. Keyword search keeps working if this is off or offline.`}
                onChange={async (v) => setSettings(await invoke('settings:update', { knowledge: { useEmbeddings: v } }))}
              />
              <Button disabled={!settings.knowledge.useEmbeddings || busy} onClick={async () => {
                setBusy(true);
                const r = await invoke('knowledge:reembed');
                setBusy(false);
                toast(r.ok ? 'info' : 'error', r.ok ? `Embedded ${r.embedded} chunks` : (r.error ?? 'Embedding failed'));
                await refresh();
              }}>Embed missing chunks</Button>
            </>
          ) : null}
        </Card>
      </div>

      {preview ? (
        <div className="dash-modal" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
          <div className="dash-modal__box" onClick={(e) => e.stopPropagation()}>
            <h2>{preview.document.title}</h2>
            <p className="dash-small">{preview.document.fileName} · {preview.document.chunkCount} chunks · {preview.document.charCount.toLocaleString()} characters extracted · sha256 {preview.document.sha256.slice(0, 12)}…</p>
            {preview.chunks.map((c) => (
              <div key={c.id} className="dash-chunk">
                <div className="dash-chunk__meta">#{c.ordinal}{c.page ? ` · page ${c.page}` : ''}{c.section ? ` · ${c.section}` : ''}</div>
                {c.text}
              </div>
            ))}
            <div className="vc-row" style={{ justifyContent: 'flex-end' }}><Button onClick={() => setPreview(null)}>Close</Button></div>
          </div>
        </div>
      ) : null}
    </>
  );
}
