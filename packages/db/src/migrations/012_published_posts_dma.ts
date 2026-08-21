// Posts imported from the DMA API have no file behind them, so the artifact
// reference has to be optional. It was NOT NULL because the first source of
// post history was an export archive on disk. SQLite cannot relax a column
// constraint in place, so the table is rebuilt.
export const MIGRATION_012 = `
CREATE TABLE published_posts_new (
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
  artifact_id     TEXT REFERENCES artifacts (id),
  retention_class TEXT NOT NULL DEFAULT 'durable_user',
  imported_at     TEXT NOT NULL
) STRICT;

INSERT INTO published_posts_new
  SELECT id, share_url, posted_at, commentary, shared_url, media_url, visibility,
         char_count, hashtags_json, language_guess, artifact_id, retention_class, imported_at
  FROM published_posts;

DROP TABLE published_posts;
ALTER TABLE published_posts_new RENAME TO published_posts;

CREATE UNIQUE INDEX idx_published_posts_dedup ON published_posts (posted_at, char_count);
CREATE INDEX idx_published_posts_time ON published_posts (posted_at);
`;
