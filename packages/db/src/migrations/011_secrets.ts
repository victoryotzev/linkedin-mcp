export const MIGRATION_011 = `
-- Secret-class values only: LinkedIn access tokens and client ids. Everything
-- else in this database is plaintext on purpose — the member is the data
-- subject, and encrypting evidence text would break FTS for no attacker it
-- actually stops.
--
-- Ciphertext is AES-256-GCM under a master key wrapped by Windows DPAPI
-- (CurrentUser). The name and key_id are the additional authenticated data, so
-- a row's ciphertext cannot be moved to another name.
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv         BLOB NOT NULL,
  auth_tag   BLOB NOT NULL,
  key_id     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
) STRICT;

-- Which app a token belongs to. LinkedIn forces the read and write lanes into
-- separate developer applications (binding an app to the Data Portability
-- default Company Page permanently blocks Sign In with LinkedIn and Share on
-- LinkedIn), so a single account can hold two client ids and two tokens.
ALTER TABLE linkedin_accounts ADD COLUMN lane TEXT NOT NULL DEFAULT 'read'
  CHECK (lane IN ('read', 'write'));
ALTER TABLE linkedin_accounts ADD COLUMN client_id TEXT;
ALTER TABLE linkedin_accounts ADD COLUMN token_secret_name TEXT;
ALTER TABLE linkedin_accounts ADD COLUMN token_expires_at TEXT;

-- Where a DMA changelog sync left off. The API only serves a rolling 28-day
-- window, so anything not persisted here is gone for good.
CREATE TABLE dma_sync_state (
  domain            TEXT PRIMARY KEY,
  last_synced_at    TEXT,
  last_watermark_ms INTEGER,
  rows_imported     INTEGER NOT NULL DEFAULT 0,
  note              TEXT
) STRICT;
`;
