import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  MigrationError,
  migrate,
  openDatabase,
  type SqliteDriver,
} from '@linkedin-mcp/db';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-mig-'));
  db = openDatabase(join(dir, 'test.sqlite3')).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('migrate', () => {
  it('applies known migrations then is idempotent', () => {
    const first = migrate(db);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    // Core tables exist after migration.
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('k', '1', 'now')");
    expect(db.get("SELECT value_json FROM settings WHERE key = 'k'")).toBeDefined();
  });

  it('fails closed on checksum drift of an applied migration', () => {
    migrate(db);
    const drifted = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: `${m.sql}\n-- edited after apply` } : m,
    );
    expect(() => migrate(db, drifted)).toThrowError(MigrationError);
  });

  it('fails closed when the database is newer than the build', () => {
    migrate(db);
    db.run(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      999,
      'from_the_future',
      'deadbeef',
      new Date().toISOString(),
    );
    expect(() => migrate(db)).toThrowError(MigrationError);
  });
});
