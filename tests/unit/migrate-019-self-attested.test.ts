import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';

// Migration 019 adds the self_attested marker. It is an ADD COLUMN rather than
// a rebuild of `sources` because that table parents three foreign keys and
// DROP TABLE enforces its implicit delete immediately — PRAGMA
// defer_foreign_keys does not defer it in this build. These tests pin both the
// upgrade path over existing data and the invariant that made the choice.

let dir: string;
let db: SqliteDriver;

const upTo18 = MIGRATIONS.filter((m) => m.version <= 18);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-mig019-'));
  db = openDatabase(join(dir, 'test.sqlite3')).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A source plus one row in every table that references it. */
function seedPopulatedSchema18(): void {
  migrate(db, upTo18);
  const now = '2026-08-19T00:00:00.000Z';

  db.run(
    `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at, enabled_at, notes)
     VALUES (?, 'folder', ?, ?, 'own_repo', 'enabled', ?, ?, ?)`,
    'src_keep',
    'C:\\evidence\\portfolio',
    'Portfolio',
    now,
    now,
    'a note',
  );
  db.run(
    `INSERT INTO import_runs (id, source_id, started_at, files_seen, files_imported)
     VALUES (?, ?, ?, 3, 3)`,
    'run_keep',
    'src_keep',
    now,
  );
  db.run(
    `INSERT INTO artifacts (id, source_id, source_relpath, sha256, size_bytes, mime, imported_at, import_run_id)
     VALUES (?, ?, 'README.md', ?, 12, 'text/markdown', ?, ?)`,
    'art_keep',
    'src_keep',
    'a'.repeat(64),
    now,
    'run_keep',
  );
  db.run(
    `INSERT INTO linkedin_snapshots (id, source_kind, source_id, imported_at, version)
     VALUES (?, 'export_csv', ?, ?, 1)`,
    'snp_keep',
    'src_keep',
    now,
  );
}

describe('migration 019 — self_attested marker', () => {
  it('upgrades a populated database without disturbing existing rows', () => {
    seedPopulatedSchema18();

    const { applied } = migrate(db);
    expect(applied).toEqual([19]);

    const source = db.get('SELECT * FROM sources WHERE id = ?', 'src_keep');
    expect(source).toBeDefined();
    expect(source!['root_path']).toBe('C:\\evidence\\portfolio');
    expect(source!['label']).toBe('Portfolio');
    expect(source!['trust']).toBe('own_repo');
    expect(source!['status']).toBe('enabled');
    expect(source!['enabled_at']).toBe('2026-08-19T00:00:00.000Z');
    expect(source!['notes']).toBe('a note');
    // Everything that predates the column is evidence the member authored
    // earlier, which is exactly what 0 means.
    expect(source!['self_attested']).toBe(0);
  });

  it('leaves every foreign key intact', () => {
    seedPopulatedSchema18();
    migrate(db);

    expect(
      db.get('SELECT source_id FROM import_runs WHERE id = ?', 'run_keep')?.['source_id'],
    ).toBe('src_keep');
    expect(db.get('SELECT source_id FROM artifacts WHERE id = ?', 'art_keep')?.['source_id']).toBe(
      'src_keep',
    );
    expect(
      db.get('SELECT source_id FROM linkedin_snapshots WHERE id = ?', 'snp_keep')?.['source_id'],
    ).toBe('src_keep');
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('stores a self-attested source alongside a normal one', () => {
    seedPopulatedSchema18();
    migrate(db);

    db.run(
      `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at, self_attested)
       VALUES (?, 'manual', ?, 'About me', 'personal_doc', 'enabled', ?, 1)`,
      'src_self',
      'manual://src_self',
      '2026-08-19T00:00:00.000Z',
    );

    expect(
      db.get('SELECT self_attested FROM sources WHERE id = ?', 'src_self')?.['self_attested'],
    ).toBe(1);
    expect(
      db.get('SELECT self_attested FROM sources WHERE id = ?', 'src_keep')?.['self_attested'],
    ).toBe(0);
  });

  it('is a no-op on a database that already has it', () => {
    migrate(db);
    expect(migrate(db).applied).toEqual([]);
  });
});
