export const MIGRATION_004 = `
CREATE TABLE claims (
  id              TEXT PRIMARY KEY,
  statement       TEXT NOT NULL,
  statement_hash  TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('candidate', 'verified', 'ambiguous', 'rejected', 'expired')),
  method          TEXT NOT NULL CHECK (method IN ('parser', 'model_proposed', 'manual')),
  confidence      REAL,
  limitations     TEXT,
  sensitivity     TEXT NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public', 'internal', 'sensitive')),
  review_by       TEXT,
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  rejected_reason TEXT,
  superseded_by   TEXT REFERENCES claims (id),
  merged_into     TEXT REFERENCES claims (id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

-- One ACTIVE claim per normalized statement; rejected tombstones stay forever
-- and are checked explicitly so a re-import can never resurrect them.
CREATE UNIQUE INDEX idx_claims_active_statement ON claims (statement_hash)
  WHERE state IN ('candidate', 'verified', 'ambiguous');
CREATE INDEX idx_claims_state ON claims (state);
CREATE INDEX idx_claims_review_by ON claims (review_by);

CREATE VIRTUAL TABLE claims_fts USING fts5(statement, content='claims', content_rowid='rowid');
CREATE TRIGGER claims_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts (rowid, statement) VALUES (new.rowid, new.statement);
END;
CREATE TRIGGER claims_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts (claims_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
END;
CREATE TRIGGER claims_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts (claims_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
  INSERT INTO claims_fts (rowid, statement) VALUES (new.rowid, new.statement);
END;

CREATE TABLE claim_evidence (
  claim_id      TEXT NOT NULL REFERENCES claims (id),
  artifact_id   TEXT NOT NULL REFERENCES artifacts (id),
  extraction_id TEXT REFERENCES extractions (id),
  location_json TEXT NOT NULL DEFAULT '{}',
  role          TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'corroborating')),
  PRIMARY KEY (claim_id, artifact_id, location_json)
) STRICT;
CREATE INDEX idx_claim_evidence_artifact ON claim_evidence (artifact_id);

CREATE TABLE claim_conflicts (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('contradiction', 'duplication', 'freshness', 'scope')),
  state           TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'dismissed')),
  resolution_note TEXT,
  resolved_by     TEXT,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE claim_conflict_members (
  conflict_id TEXT NOT NULL REFERENCES claim_conflicts (id),
  claim_id    TEXT NOT NULL REFERENCES claims (id),
  PRIMARY KEY (conflict_id, claim_id)
) STRICT;

CREATE TABLE coverage_reports (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL CHECK (subject IN ('freeform', 'draft', 'patch')),
  subject_ref     TEXT,
  text_sha256     TEXT NOT NULL UNIQUE,
  sentences_json  TEXT NOT NULL,
  supported_count INTEGER NOT NULL,
  total_count     INTEGER NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;
`;
