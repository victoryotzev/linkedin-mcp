// A coverage report is a function of BOTH the text and the verified-claim
// corpus it was scored against. Keying it on the text alone made reports go
// stale the moment a claim was verified: the cached answer said "unsupported"
// for a sentence that had just gained its evidence. Rebuild the table with a
// composite key that includes a corpus fingerprint.
export const MIGRATION_007 = `
CREATE TABLE coverage_reports_new (
  id                 TEXT PRIMARY KEY,
  subject            TEXT NOT NULL CHECK (subject IN ('freeform', 'draft', 'patch')),
  subject_ref        TEXT,
  text_sha256        TEXT NOT NULL,
  corpus_fingerprint TEXT NOT NULL,
  sentences_json     TEXT NOT NULL,
  supported_count    INTEGER NOT NULL,
  total_count        INTEGER NOT NULL,
  created_at         TEXT NOT NULL
) STRICT;

INSERT INTO coverage_reports_new (id, subject, subject_ref, text_sha256, corpus_fingerprint, sentences_json, supported_count, total_count, created_at)
  SELECT id, subject, subject_ref, text_sha256, 'legacy', sentences_json, supported_count, total_count, created_at
  FROM coverage_reports;

DROP TABLE coverage_reports;
ALTER TABLE coverage_reports_new RENAME TO coverage_reports;

CREATE UNIQUE INDEX idx_coverage_text_corpus ON coverage_reports (text_sha256, corpus_fingerprint);
`;
