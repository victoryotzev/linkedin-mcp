import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from './driver.ts';
import { MIGRATIONS, type Migration } from './migrations/index.ts';

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

// Fail-closed in both directions: a database from a newer build refuses to be
// touched by older code, and an applied migration whose SQL no longer matches
// its recorded checksum stops the process.
export function migrate(
  db: SqliteDriver,
  migrations: readonly Migration[] = MIGRATIONS,
): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const applied: number[] = [];

  withWriteTx(db, () => {
    const rows = db.all('SELECT version, checksum FROM schema_migrations');
    const seen = new Map<number, string>(
      rows.map((r) => [Number(r['version']), String(r['checksum'])]),
    );

    const maxKnown = sorted.at(-1)?.version ?? 0;
    for (const version of seen.keys()) {
      if (version > maxKnown) {
        throw new MigrationError(
          `database schema version ${version} is newer than this build (max ${maxKnown}); update the application`,
        );
      }
    }

    for (const migration of sorted) {
      const sum = checksum(migration.sql);
      const existing = seen.get(migration.version);
      if (existing !== undefined) {
        if (existing !== sum) {
          throw new MigrationError(
            `migration ${migration.version} (${migration.name}) checksum mismatch: recorded ${existing}, computed ${sum}`,
          );
        }
        continue;
      }
      db.exec(migration.sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        migration.version,
        migration.name,
        sum,
        new Date().toISOString(),
      );
      applied.push(migration.version);
    }
  });

  return { applied };
}
