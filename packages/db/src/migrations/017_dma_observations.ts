export const MIGRATION_017 = `
-- Three separate repairs, all forced by what LinkedIn's Data Portability APIs
-- actually promise.
--
-- (1) The changelog cursor was local wall-clock time. LinkedIn's contract is an
--     INCLUSIVE startTime seeded from the latest returned processedAt, so a
--     wall-clock watermark permanently skips every event processed after the
--     request started. The new cursor lives in its own column and is seeded
--     from the events already on disk -- never from the old, wrong watermark.
-- (2) Changelog events were an opaque blob. The raw payload stays immutable and
--     append-only; normalized metadata is projected alongside it so resource
--     history, processedAt ordering and replay resolution become queryable.
-- (3) linkedin_snapshots.taken_at held the local request time for DMA rows, as
--     though LinkedIn had told us when it generated the data. It never does.
--     The value moves to an observation row that says what it really was.

-- ---------------------------------------------------------------------------
-- 1. Normalized changelog metadata beside the immutable raw event.
-- ---------------------------------------------------------------------------
ALTER TABLE dma_changelog_events ADD COLUMN upstream_event_id TEXT;
ALTER TABLE dma_changelog_events ADD COLUMN activity_id       TEXT;
ALTER TABLE dma_changelog_events ADD COLUMN resource_name     TEXT;
ALTER TABLE dma_changelog_events ADD COLUMN resource_id       TEXT;
ALTER TABLE dma_changelog_events ADD COLUMN method            TEXT;
ALTER TABLE dma_changelog_events ADD COLUMN captured_at_ms    INTEGER;
ALTER TABLE dma_changelog_events ADD COLUMN processed_at_ms   INTEGER;
ALTER TABLE dma_changelog_events ADD COLUMN config_version    INTEGER;
ALTER TABLE dma_changelog_events ADD COLUMN activity_status   TEXT;

-- Backfill from the payload that is already stored. json_valid guards rows that
-- are somehow not JSON; every extraction is type-checked rather than coerced,
-- because a silently coerced timestamp is exactly how a cursor runs away.
--
-- The upper bound on the two timestamps is the important one: a single corrupt
-- far-future processedAt would otherwise advance the cursor past the whole
-- 28-day window, and those events are then gone for good. The same clamp is
-- applied in TypeScript on every sync -- see isValidEventTimestamp.
UPDATE dma_changelog_events SET
  upstream_event_id = CASE
    WHEN json_valid(event_json)
     AND json_type(event_json, '$.id') IN ('text', 'integer')
    THEN CAST(json_extract(event_json, '$.id') AS TEXT) END,
  activity_id = CASE
    WHEN json_valid(event_json) AND json_type(event_json, '$.activityId') = 'text'
    THEN json_extract(event_json, '$.activityId') END,
  resource_name = CASE
    WHEN json_valid(event_json) AND json_type(event_json, '$.resourceName') = 'text'
    THEN json_extract(event_json, '$.resourceName') END,
  resource_id = CASE
    WHEN json_valid(event_json)
     AND json_type(event_json, '$.resourceId') IN ('text', 'integer')
    THEN CAST(json_extract(event_json, '$.resourceId') AS TEXT) END,
  method = CASE
    WHEN json_valid(event_json) AND json_type(event_json, '$.method') = 'text'
    THEN json_extract(event_json, '$.method') END,
  config_version = CASE
    WHEN json_valid(event_json) AND json_type(event_json, '$.configVersion') = 'integer'
    THEN CAST(json_extract(event_json, '$.configVersion') AS INTEGER) END,
  activity_status = CASE
    WHEN json_valid(event_json) AND json_type(event_json, '$.activityStatus') = 'text'
    THEN json_extract(event_json, '$.activityStatus') END,
  captured_at_ms = CASE
    WHEN json_valid(event_json)
     AND json_type(event_json, '$.capturedAt') = 'integer'
     AND CAST(json_extract(event_json, '$.capturedAt') AS INTEGER) > 0
     AND CAST(json_extract(event_json, '$.capturedAt') AS INTEGER)
         <= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 300000)
    THEN CAST(json_extract(event_json, '$.capturedAt') AS INTEGER) END,
  processed_at_ms = CASE
    WHEN json_valid(event_json)
     AND json_type(event_json, '$.processedAt') = 'integer'
     AND CAST(json_extract(event_json, '$.processedAt') AS INTEGER) > 0
     AND CAST(json_extract(event_json, '$.processedAt') AS INTEGER)
         <= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 300000)
    THEN CAST(json_extract(event_json, '$.processedAt') AS INTEGER) END;

CREATE INDEX idx_dma_changelog_processed ON dma_changelog_events (processed_at_ms);
CREATE INDEX idx_dma_changelog_resource
  ON dma_changelog_events (resource_name, resource_id, processed_at_ms);
CREATE INDEX idx_dma_changelog_activity
  ON dma_changelog_events (activity_id, processed_at_ms);

-- ---------------------------------------------------------------------------
-- 2. The real cursor.
-- ---------------------------------------------------------------------------
-- watermark_ms is deliberately left in place and keeps recording the local time
-- of the last sync. It is diagnostics only from here on; nothing reads it to
-- decide what to fetch.
ALTER TABLE dma_changelog_watermarks ADD COLUMN processed_at_cursor_ms INTEGER;

-- Set on repair, cleared by the first successful sync afterwards. While it is
-- set, that sync ignores the seeded cursor and asks for the full 28-day window
-- once. The seed can therefore only ever be too conservative: a re-read costs
-- one request and deduplicates on event_hash, whereas a seed that landed too
-- high would silently skip events LinkedIn will never serve again.
ALTER TABLE dma_changelog_watermarks ADD COLUMN cursor_repaired INTEGER NOT NULL DEFAULT 0;

UPDATE dma_changelog_watermarks
SET processed_at_cursor_ms = (SELECT MAX(processed_at_ms) FROM dma_changelog_events),
    cursor_repaired = 1
WHERE lane = 'member';

-- ---------------------------------------------------------------------------
-- 3. What a DMA read actually observed.
-- ---------------------------------------------------------------------------
-- One row per live read. The snapshot it points at may be shared with an
-- earlier observation: when LinkedIn returns byte-identical content there is no
-- new profile state to version, only a new observation of the same one.
CREATE TABLE dma_snapshot_observations (
  seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
  id                      TEXT NOT NULL UNIQUE,
  snapshot_id             TEXT REFERENCES linkedin_snapshots (id),
  -- Local clock, and named so: LinkedIn supplies no data-generation timestamp
  -- anywhere in the Snapshot API, so these describe our request, not its data.
  requested_at            TEXT NOT NULL,
  request_completed_at    TEXT,
  observed_at             TEXT NOT NULL,
  content_fingerprint     TEXT,
  previous_observation_id TEXT,
  content_identical       INTEGER NOT NULL DEFAULT 0,
  changelog_cursor_ms     INTEGER,
  newest_profile_event_captured_ms  INTEGER,
  newest_profile_event_processed_ms INTEGER,
  requested_domains_json  TEXT,
  freshness_status        TEXT,
  -- 1 for rows synthesised by this migration from a pre-017 snapshot, whose id
  -- is the literal marker 'dmo_legacy_<snapshot_id>' rather than a ULID.
  backfilled              INTEGER NOT NULL DEFAULT 0,
  retention_class         TEXT NOT NULL DEFAULT 'durable_dma'
) STRICT;
CREATE INDEX idx_dma_obs_snapshot ON dma_snapshot_observations (snapshot_id);
CREATE INDEX idx_dma_obs_observed ON dma_snapshot_observations (observed_at);

-- Per-domain outcome. LinkedIn states that domains become available at
-- different times "depending on the effort required by LinkedIn to collate this
-- data", so an empty page zero is not proof the member has no entries -- it is
-- its own status, distinct from a populated result and from a failure.
CREATE TABLE dma_snapshot_domain_results (
  observation_id  TEXT NOT NULL REFERENCES dma_snapshot_observations (id),
  domain          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
    'populated', 'empty_or_not_ready', 'failed', 'pagination_incomplete'
  )),
  row_count       INTEGER NOT NULL DEFAULT 0,
  fingerprint     TEXT,
  failure_reason  TEXT,
  -- Stored only when this domain's fingerprint changed; an unchanged domain
  -- points at the observation that still holds the bytes.
  raw_json        TEXT,
  raw_same_as_observation_id TEXT,
  -- Set when the rendered profile field was reused from an earlier observation
  -- because this call did not return usable data for the domain. Any value here
  -- forces the observation out of every "complete" freshness verdict.
  carried_forward_from TEXT,
  PRIMARY KEY (observation_id, domain)
) STRICT;
CREATE INDEX idx_dma_domain_results_domain
  ON dma_snapshot_domain_results (domain, observation_id);

-- ---------------------------------------------------------------------------
-- 4. Repair the misleading taken_at on snapshots already on disk.
-- ---------------------------------------------------------------------------
-- The old value is preserved as what it always was -- the moment our request
-- finished -- and then removed from the column that claims to say when LinkedIn
-- generated the data. Export and profile-PDF snapshots are untouched: for those
-- taken_at is a real, user-supplied generation time.
INSERT INTO dma_snapshot_observations
  (id, snapshot_id, requested_at, request_completed_at, observed_at,
   content_identical, backfilled, retention_class)
SELECT
  'dmo_legacy_' || s.id,
  s.id,
  COALESCE(s.taken_at, s.imported_at),
  s.taken_at,
  COALESCE(s.taken_at, s.imported_at),
  0,
  1,
  'durable_dma'
FROM linkedin_snapshots s
WHERE s.source_kind = 'dma_snapshot'
ORDER BY s.version;

UPDATE linkedin_snapshots SET taken_at = NULL WHERE source_kind = 'dma_snapshot';
`;
