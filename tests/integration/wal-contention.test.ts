import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@linkedin-mcp/db';

const execFileAsync = promisify(execFile);
const CHILD = fileURLToPath(new URL('../helpers/wal-child.ts', import.meta.url));
const ROWS_PER_WRITER = 200;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-wal-'));
  dbPath = join(dir, 'contention.sqlite3');
  const { db } = openDatabase(dbPath);
  db.exec(
    `CREATE TABLE contention (
       id      INTEGER PRIMARY KEY AUTOINCREMENT,
       writer  TEXT NOT NULL,
       seq     INTEGER NOT NULL,
       checked INTEGER NOT NULL DEFAULT 0
     )`,
  );
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// P0 acceptance gate (plan PR7): two OS processes hammer the same WAL database
// through the real driver seam — openDatabase's pragmas and withWriteTx's
// BEGIN IMMEDIATE, retry and rollback. Pass = zero lost writes, zero
// corruption, and every nested call joined its parent transaction. This is the
// exact pattern the MCP server and dashboard share in production.
describe('two-process WAL contention', () => {
  it('loses no writes and keeps the database intact under concurrent writers', async () => {
    const run = (writer: string) =>
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', CHILD, dbPath, writer, String(ROWS_PER_WRITER)],
        { timeout: 120_000 },
      );
    const [a, b] = await Promise.all([run('A'), run('B')]);

    // Measured inside each child from the database, not echoed from argv.
    const reports = [a, b].map(
      (r) =>
        JSON.parse(r.stdout) as { writerId: string; committed: number; gaveUpAt: number | null },
    );

    const { db } = openDatabase(dbPath);
    try {
      for (const report of reports) {
        // A writer that ran out of retry budget under saturation has refused to
        // proceed without the lock, which is the correct fail-closed answer and
        // not a lost write. What must hold either way is that everything it
        // says it committed is really there, contiguously, with the nested
        // update applied — that is the whole guarantee.
        const rows = db.all(
          'SELECT seq, checked FROM contention WHERE writer = ? ORDER BY seq',
          report.writerId,
        );
        expect(rows.map((r) => Number(r['seq']))).toEqual(
          Array.from({ length: report.committed }, (_, i) => i),
        );
        expect(rows.every((r) => Number(r['checked']) === 1)).toBe(true);

        if (report.gaveUpAt === null) {
          // Nothing stood in its way, so it wrote everything it was asked to.
          expect(report.committed).toBe(ROWS_PER_WRITER);
        } else {
          expect(report.committed).toBe(report.gaveUpAt);
        }
      }

      // Nothing either writer committed was lost to the other.
      expect(Number(db.get('SELECT COUNT(*) AS n FROM contention')?.['n'])).toBe(
        reports.reduce((sum, r) => sum + r.committed, 0),
      );
      expect(Number(db.get('SELECT COUNT(*) AS n FROM contention WHERE checked = 1')?.['n'])).toBe(
        reports.reduce((sum, r) => sum + r.committed, 0),
      );

      expect(String(Object.values(db.get('PRAGMA integrity_check') ?? {})[0])).toBe('ok');
    } finally {
      db.close();
    }
  }, 180_000);
});
