/**
 * Minimal synchronous SQLite surface. In the app this is Node's built-in
 * `node:sqlite` DatabaseSync (bundled with Electron's Node runtime — no native
 * module to compile). Tests use the same module under Node 22+.
 */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        page_count INTEGER,
        char_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        modified_at INTEGER,
        status TEXT NOT NULL DEFAULT 'indexed',
        error TEXT,
        profile_id TEXT,
        embedded_model TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        page INTEGER,
        section TEXT,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED, text, title, section, tokenize = 'porter unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_cards (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_profiles (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        mode TEXT NOT NULL,
        profile_name TEXT,
        title TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_id);
      CREATE TABLE IF NOT EXISTS perf_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL,
        ms REAL NOT NULL,
        at INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        label TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_perf_stage ON perf_events(stage, at);
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        amount REAL,
        cost_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_events(at);
      CREATE TABLE IF NOT EXISTS capture_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `,
  },
];

export function migrate(db: SqlDatabase): number {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  let current = row?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
      db.exec('COMMIT');
      current = m.version;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return current;
}

export function tx<T>(db: SqlDatabase, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function newId(prefix = ''): string {
  const rnd = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return prefix ? `${prefix}_${rnd}` : rnd;
}
