export const MIGRATION_018 = `
-- How many domains an observation could actually compare against a previous
-- fingerprint.
--
-- The freshness verdict anchors "newer than last time" on the most recent
-- observation whose Snapshot content demonstrably moved, and it identified
-- those by content_identical = 0. But 0 is also what an observation records
-- when it compared nothing at all — a first read, a read of a domain never
-- fetched before, a read where every domain failed. Such an observation was
-- being promoted to "content moved here", which re-anchors the baseline past a
-- pending edit and silences a lag that is still happening.
--
-- NULL on rows written before this column existed. Those are read as
-- informative, which is exactly how they were treated until now, so the repair
-- changes no existing verdict.
ALTER TABLE dma_snapshot_observations ADD COLUMN comparable_domain_count INTEGER;
`;
