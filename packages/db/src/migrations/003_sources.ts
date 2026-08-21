// FTS5 note: this migration creates an FTS5 virtual table. FTS5 was verified
// present in this machine's node:sqlite (SQLite 3.51.3); on a build without
// FTS5 the migration fails visibly and the driver seam's better-sqlite3
// fallback (which bundles FTS5) is the remedy — never a silent degradation of
// the schema.
export const MIGRATION_003 = `
CREATE TABLE sources (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('repo', 'document', 'folder', 'linkedin_export', 'manual')),
  root_path      TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL,
  trust          TEXT NOT NULL CHECK (trust IN ('personal_doc', 'own_repo', 'local_clone_reference')),
  status         TEXT NOT NULL CHECK (status IN ('pending_review', 'enabled', 'disabled', 'archived')),
  registered_at  TEXT NOT NULL,
  enabled_at     TEXT,
  last_import_at TEXT,
  notes          TEXT
) STRICT;

CREATE TABLE import_runs (
  id               TEXT PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources (id),
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  dry_run          INTEGER NOT NULL DEFAULT 0,
  files_seen       INTEGER NOT NULL DEFAULT 0,
  files_imported   INTEGER NOT NULL DEFAULT 0,
  files_skipped_dup INTEGER NOT NULL DEFAULT 0,
  files_rejected   INTEGER NOT NULL DEFAULT 0,
  rejects_json     TEXT NOT NULL DEFAULT '[]',
  error            TEXT
) STRICT;
CREATE INDEX idx_import_runs_source ON import_runs (source_id, started_at);

CREATE TABLE artifacts (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources (id),
  source_relpath TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  mime           TEXT NOT NULL,
  original_mtime TEXT,
  imported_at    TEXT NOT NULL,
  import_run_id  TEXT NOT NULL REFERENCES import_runs (id),
  superseded_by  TEXT REFERENCES artifacts (id)
) STRICT;
CREATE UNIQUE INDEX idx_artifacts_active_relpath
  ON artifacts (source_id, source_relpath) WHERE superseded_by IS NULL;
CREATE INDEX idx_artifacts_sha ON artifacts (sha256);

CREATE TABLE extractions (
  id               TEXT PRIMARY KEY,
  artifact_id      TEXT NOT NULL REFERENCES artifacts (id),
  parser_name      TEXT NOT NULL,
  parser_version   INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  output_json      TEXT,
  text             TEXT,
  text_sha256      TEXT,
  contains_secrets INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_extractions_artifact ON extractions (artifact_id, parser_name, parser_version);

CREATE VIRTUAL TABLE extractions_fts USING fts5(text, content='extractions', content_rowid='rowid');

CREATE TRIGGER extractions_ai AFTER INSERT ON extractions BEGIN
  INSERT INTO extractions_fts (rowid, text) VALUES (new.rowid, coalesce(new.text, ''));
END;
CREATE TRIGGER extractions_ad AFTER DELETE ON extractions BEGIN
  INSERT INTO extractions_fts (extractions_fts, rowid, text) VALUES ('delete', old.rowid, coalesce(old.text, ''));
END;
CREATE TRIGGER extractions_au AFTER UPDATE ON extractions BEGIN
  INSERT INTO extractions_fts (extractions_fts, rowid, text) VALUES ('delete', old.rowid, coalesce(old.text, ''));
  INSERT INTO extractions_fts (rowid, text) VALUES (new.rowid, coalesce(new.text, ''));
END;
`;
