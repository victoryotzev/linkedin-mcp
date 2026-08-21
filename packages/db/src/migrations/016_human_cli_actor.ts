export const MIGRATION_016 = `
-- Human-authority actions can be performed either in the loopback dashboard or
-- through the explicit local control CLI. Keep them distinguishable in the
-- hash-chained audit log; neither is an MCP/model actor.
CREATE TABLE audit_events_v16 (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('mcp_host', 'dashboard', 'human_cli', 'system')),
  subject_type TEXT NOT NULL,
  subject_id   TEXT,
  payload_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

INSERT INTO audit_events_v16
  (seq, event_type, actor, subject_type, subject_id, payload_json, prev_hash, content_hash, created_at)
SELECT
  seq, event_type, actor, subject_type, subject_id, payload_json, prev_hash, content_hash, created_at
FROM audit_events
ORDER BY seq;

DROP TABLE audit_events;
ALTER TABLE audit_events_v16 RENAME TO audit_events;
CREATE INDEX idx_audit_subject ON audit_events (subject_type, subject_id);
`;
