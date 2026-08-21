export const MIGRATION_015 = `
-- The DMA changelog is a rolling window. Persist the opaque upstream event
-- before advancing the fetch watermark so a crash can replay safely without
-- losing data. The canonical payload hash is both the identity and dedupe key.
CREATE TABLE dma_changelog_events (
  event_hash      TEXT PRIMARY KEY,
  event_json      TEXT NOT NULL,
  requested_since_ms INTEGER NOT NULL,
  received_at     TEXT NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'durable_dma'
) STRICT;
CREATE INDEX idx_dma_changelog_received ON dma_changelog_events (received_at);

CREATE TABLE dma_changelog_watermarks (
  lane                 TEXT PRIMARY KEY CHECK (lane = 'member'),
  watermark_ms         INTEGER NOT NULL,
  last_window_start_ms INTEGER NOT NULL,
  last_synced_at       TEXT NOT NULL,
  last_rows_fetched    INTEGER NOT NULL,
  last_rows_imported   INTEGER NOT NULL
) STRICT;
`;
