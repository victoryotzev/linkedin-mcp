export const MIGRATION_010 = `
-- Manual metric imports. LinkedIn's member analytics APIs are gated behind
-- Community Management access that individuals cannot obtain, so every number
-- here is transcribed by the member from their own LinkedIn UI (or, later, the
-- DMA lane). Provenance and retention class are recorded per observation
-- because the storage rules differ by source.
CREATE TABLE analytics_observations (
  id                    TEXT PRIMARY KEY,
  subject_type          TEXT NOT NULL CHECK (subject_type IN ('post', 'profile', 'follower')),
  subject_ref           TEXT NOT NULL,
  metric                TEXT NOT NULL,
  value                 REAL NOT NULL,
  observed_at           TEXT NOT NULL,
  window_start          TEXT,
  window_end            TEXT,
  source                TEXT NOT NULL CHECK (source IN ('manual_import', 'dma', 'api')),
  provenance_artifact_id TEXT REFERENCES artifacts (id),
  retention_class       TEXT NOT NULL DEFAULT 'durable_user',
  note                  TEXT,
  imported_at           TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_observation_dedup
  ON analytics_observations (subject_ref, metric, observed_at);
CREATE INDEX idx_observation_subject ON analytics_observations (subject_ref, metric);
CREATE INDEX idx_observation_retention ON analytics_observations (retention_class);
`;
