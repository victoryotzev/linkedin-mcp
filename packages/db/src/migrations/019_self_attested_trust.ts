export const MIGRATION_019 = `
-- Marks evidence the member typed rather than authored earlier: onboarding
-- self-description, entered into a box, corroborated by nothing. It ranks
-- below personal_doc, and the domain layer surfaces it as a fourth trust class
-- (see SOURCE_TRUSTS) so nothing above the database has to know it is stored
-- as a flag.
--
-- Why a column and not a fourth value in the trust CHECK constraint: SQLite
-- cannot alter a CHECK in place, so that would mean rebuilding \`sources\`. That
-- table is the parent of three foreign keys — import_runs.source_id,
-- artifacts.source_id and linkedin_snapshots.source_id — and DROP TABLE
-- performs an implicit DELETE that is enforced immediately. PRAGMA
-- defer_foreign_keys does not rescue it (verified against this build), so the
-- rebuild would only work with foreign keys disabled around the whole
-- migration transaction.
--
-- That was the deciding factor. Disabling foreign keys in the runner would
-- apply to every future migration, meaning a buggy one could orphan rows with
-- nothing left to catch it. Trading a permanent safety property for one CHECK
-- constraint is a bad exchange, and ADD COLUMN reaches the same place with an
-- atomic statement that cannot lose a row.
ALTER TABLE sources ADD COLUMN self_attested INTEGER NOT NULL DEFAULT 0;
`;
