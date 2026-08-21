export const MIGRATION_009 = `
-- Append-only, hash-chained audit log. Every external-effect decision writes
-- here; the chain makes silent edits detectable, and approval/publish paths
-- refuse to run when it does not verify.
CREATE TABLE audit_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('mcp_host', 'dashboard', 'system')),
  subject_type TEXT NOT NULL,
  subject_id   TEXT,
  payload_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_audit_subject ON audit_events (subject_type, subject_id);

-- The account an approval is bound to. Person URN stays NULL until OIDC
-- verification (P13); binding by row id already prevents cross-account use.
CREATE TABLE linkedin_accounts (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  person_urn TEXT,
  status     TEXT NOT NULL CHECK (status IN ('unverified', 'verified', 'revoked')),
  created_at TEXT NOT NULL
) STRICT;

-- Revision-bound, single-use approvals. Granting is reachable only from the
-- dashboard service path; the MCP surface can request but never grant.
CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  action           TEXT NOT NULL CHECK (action IN ('publish_post')),
  draft_id         TEXT NOT NULL REFERENCES post_drafts (id),
  revision_hash    TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  account_id       TEXT NOT NULL REFERENCES linkedin_accounts (id),
  visibility       TEXT NOT NULL,
  media_hashes_json TEXT NOT NULL DEFAULT '[]',
  intended_time    TEXT,
  state            TEXT NOT NULL CHECK (state IN ('pending', 'granted', 'consumed', 'invalidated', 'expired', 'denied')),
  requested_by     TEXT NOT NULL CHECK (requested_by IN ('mcp_host', 'dashboard')),
  granted_at       TEXT,
  consumed_at      TEXT,
  expires_at       TEXT NOT NULL,
  invalidated_by   TEXT,
  created_at       TEXT NOT NULL
) STRICT;
-- At most one live approval per draft.
CREATE UNIQUE INDEX idx_approvals_live ON approvals (draft_id)
  WHERE state IN ('pending', 'granted');

CREATE TABLE publications (
  id                TEXT PRIMARY KEY,
  draft_id          TEXT NOT NULL REFERENCES post_drafts (id),
  revision_hash     TEXT NOT NULL,
  approval_id       TEXT NOT NULL UNIQUE REFERENCES approvals (id),
  idempotency_key   TEXT NOT NULL UNIQUE,
  request_hash      TEXT NOT NULL,
  adapter           TEXT NOT NULL CHECK (adapter IN ('dry_run', 'linkedin_rest')),
  linkedin_post_urn TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'ambiguous', 'reconciled_success', 'reconciled_failed')),
  attempted_at      TEXT NOT NULL,
  resolved_at       TEXT,
  response_meta_json TEXT,
  retention_class   TEXT NOT NULL DEFAULT 'durable_user'
) STRICT;
CREATE INDEX idx_publications_outcome ON publications (outcome);
`;
