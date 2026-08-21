export const MIGRATION_008 = `
-- The member's own published history (from their export). Kept durable
-- because it is DMA/self-export data about themselves, and it is what
-- repetition checks and voice analysis compare against.
CREATE TABLE published_posts (
  id              TEXT PRIMARY KEY,
  share_url       TEXT,
  posted_at       TEXT NOT NULL,
  commentary      TEXT NOT NULL,
  shared_url      TEXT,
  media_url       TEXT,
  visibility      TEXT,
  char_count      INTEGER NOT NULL,
  hashtags_json   TEXT NOT NULL DEFAULT '[]',
  language_guess  TEXT,
  artifact_id     TEXT NOT NULL REFERENCES artifacts (id),
  retention_class TEXT NOT NULL DEFAULT 'durable_user',
  imported_at     TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_published_posts_dedup ON published_posts (posted_at, char_count);
CREATE INDEX idx_published_posts_time ON published_posts (posted_at);

CREATE TABLE content_pillars (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  audience    TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE post_drafts (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT NOT NULL,
  pillar_id             TEXT REFERENCES content_pillars (id),
  state                 TEXT NOT NULL CHECK (state IN ('draft', 'validated', 'approved', 'published', 'abandoned')),
  current_revision      INTEGER NOT NULL DEFAULT 0,
  current_revision_hash TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE TABLE draft_revisions (
  draft_id      TEXT NOT NULL REFERENCES post_drafts (id),
  revision      INTEGER NOT NULL,
  body_text     TEXT NOT NULL,
  media_json    TEXT NOT NULL DEFAULT '[]',
  visibility    TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'CONNECTIONS')),
  revision_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (draft_id, revision)
) STRICT;

CREATE VIRTUAL TABLE drafts_fts USING fts5(body_text, content='draft_revisions', content_rowid='rowid');
CREATE TRIGGER draft_revisions_ai AFTER INSERT ON draft_revisions BEGIN
  INSERT INTO drafts_fts (rowid, body_text) VALUES (new.rowid, new.body_text);
END;
CREATE TRIGGER draft_revisions_ad AFTER DELETE ON draft_revisions BEGIN
  INSERT INTO drafts_fts (drafts_fts, rowid, body_text) VALUES ('delete', old.rowid, old.body_text);
END;

CREATE TABLE validation_reports (
  id            TEXT PRIMARY KEY,
  draft_id      TEXT NOT NULL REFERENCES post_drafts (id),
  revision_hash TEXT NOT NULL,
  passed        INTEGER NOT NULL,
  checks_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_validation_draft ON validation_reports (draft_id, created_at);

CREATE TABLE calendar_entries (
  id            TEXT PRIMARY KEY,
  draft_id      TEXT REFERENCES post_drafts (id),
  pillar_id     TEXT REFERENCES content_pillars (id),
  intended_date TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('planned', 'drafted', 'approved', 'published', 'skipped')),
  note          TEXT
) STRICT;
CREATE INDEX idx_calendar_date ON calendar_entries (intended_date);
`;
