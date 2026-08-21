export const MIGRATION_002 = `
CREATE TABLE policy_versions (
  id             TEXT PRIMARY KEY,
  capability_key TEXT NOT NULL,
  policy_text    TEXT NOT NULL,
  policy_sha256  TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  retrieved_at   TEXT NOT NULL,
  effective_at   TEXT
) STRICT;

CREATE TABLE capabilities (
  feature           TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN (
    'unavailable', 'configured', 'verified', 'expired', 'revoked', 'disabled', 'blocked'
  )),
  blockers_json     TEXT NOT NULL DEFAULT '[]',
  api_version       TEXT,
  verified_at       TEXT,
  policy_version_id TEXT REFERENCES policy_versions (id),
  notes             TEXT,
  updated_at        TEXT NOT NULL
) STRICT;
`;
