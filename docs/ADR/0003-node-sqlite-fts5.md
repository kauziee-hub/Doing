# ADR 0003 — Storage and retrieval: built-in `node:sqlite` + FTS5, optional vectors

**Status:** accepted · 2026-11-19

**Context.** Documents, history, perf and usage need SQLite with full-text search. Native modules (better-sqlite3) need node-gyp/MSVC and Electron ABI rebuilds.

**Decision.** Use Node's built-in `node:sqlite` (`DatabaseSync`; SQLite 3.54 inside Electron 45's Node 24, FTS5 verified at runtime). Retrieval = FTS5 bm25 (every query term quoted so user text cannot inject FTS syntax) fused with optional Gemini embeddings (`gemini-embedding-001`, 768-d, brute-force cosine in memory) by reciprocal-rank fusion, a first-person boost for "my facts", and at most 3 chunks per document. Query embedding gets a 900 ms budget; retrieval falls back to FTS only.

**Consequences.** No native Node modules → main bundles to plain JS and packages without `node_modules`. Brute-force vectors suit personal corpora (thousands of chunks); a vector index would be needed past ~100k chunks.
