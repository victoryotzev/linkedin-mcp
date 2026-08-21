export const MIGRATION_001 = `
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE state_handles (
  handle      TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('cursor', 'pending_action')),
  payload_json TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX idx_state_handles_expiry ON state_handles (expires_at);
`;
