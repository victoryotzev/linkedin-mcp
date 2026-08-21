export const MIGRATION_006 = `
CREATE TABLE change_sets (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL REFERENCES linkedin_snapshots (id),
  state            TEXT NOT NULL CHECK (state IN ('open', 'exported', 'closed')),
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE field_patches (
  id                           TEXT PRIMARY KEY,
  change_set_id                TEXT NOT NULL REFERENCES change_sets (id),
  field_key                    TEXT NOT NULL,
  old_text                     TEXT NOT NULL,
  new_text                     TEXT NOT NULL,
  char_limit                   INTEGER,
  char_count                   INTEGER NOT NULL,
  char_limit_ok                INTEGER NOT NULL,
  claim_ids_json               TEXT NOT NULL DEFAULT '[]',
  rationale                    TEXT,
  risk_note                    TEXT,
  kind                         TEXT NOT NULL CHECK (kind IN ('required_fix', 'optional_improvement')),
  state                        TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'applied', 'superseded', 'rejected')),
  applied_at                   TEXT,
  applied_verified_snapshot_id TEXT REFERENCES linkedin_snapshots (id),
  revision_hash                TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_field_patches_changeset ON field_patches (change_set_id, state);
`;
