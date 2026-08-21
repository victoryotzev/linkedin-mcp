export const MIGRATION_005 = `
CREATE TABLE canonical_sections (
  section_key         TEXT PRIMARY KEY CHECK (section_key IN (
    'headline', 'about', 'experience', 'education', 'skills', 'certifications',
    'audiences', 'positioning_brief', 'keyword_map'
  )),
  current_revision_id TEXT REFERENCES canonical_revisions (id)
) STRICT;

CREATE TABLE canonical_revisions (
  id                TEXT PRIMARY KEY,
  section_key       TEXT NOT NULL REFERENCES canonical_sections (section_key),
  content_text      TEXT NOT NULL,
  content_json      TEXT,
  content_hash      TEXT NOT NULL,
  based_on_revision TEXT REFERENCES canonical_revisions (id),
  claim_ids_json    TEXT NOT NULL DEFAULT '[]',
  rationale         TEXT,
  author            TEXT NOT NULL CHECK (author IN ('user', 'mcp_host')),
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_canonical_revisions_section ON canonical_revisions (section_key, created_at);

CREATE TABLE linkedin_snapshots (
  id          TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('export_csv', 'profile_pdf', 'dma_snapshot')),
  source_id   TEXT NOT NULL REFERENCES sources (id),
  taken_at    TEXT,
  imported_at TEXT NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'durable_user',
  version     INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_snapshots_version ON linkedin_snapshots (version);

CREATE TABLE snapshot_fields (
  snapshot_id TEXT NOT NULL REFERENCES linkedin_snapshots (id),
  field_key   TEXT NOT NULL,
  value_text  TEXT NOT NULL,
  char_count  INTEGER NOT NULL,
  raw_json    TEXT,
  PRIMARY KEY (snapshot_id, field_key)
) STRICT;
`;
