import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@linkedin-mcp/db';

const execFileAsync = promisify(execFile);
const CHILD = fileURLToPath(new URL('../helpers/open-race-child.ts', import.meta.url));

// Two surfaces opening one home at the same time.
//
// This is the ordinary case, not an exotic one: the MCP server and the
// dashboard both open the same database, and a member who launches the
// dashboard while their MCP host is starting hits exactly this.
//
// It used to fail. Switching journal_mode takes a brief exclusive lock, and
// busy_timeout was set after it — so the second opener died immediately with a
// raw "database is locked" stack instead of waiting a few milliseconds. The
// pragma order is the fix, and this is the regression test for it.

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-open-race-'));
  dbPath = join(dir, 'linkedin.sqlite3');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('several processes opening one database together', () => {
  it('all succeed, rather than the losers dying on a locked database', async () => {
    const goFile = join(dir, 'go');
    const racers = [0, 1, 2, 3, 4, 5].map(() =>
      execFileAsync(process.execPath, ['--import', 'tsx', CHILD, dbPath, goFile], {
        timeout: 120_000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(goFile, 'go');

    const results = (await Promise.all(racers)).map(
      (r) =>
        JSON.parse(r.stdout) as {
          ok: boolean;
          message?: string;
          journal_mode?: string;
          busy_timeout?: number;
        },
    );

    const failures = results.filter((r) => !r.ok);
    expect(
      failures.map((f) => f.message),
      'every opener should have waited for the lock rather than failing',
    ).toEqual([]);
  }, 180_000);

  it('leaves every connection with the same pragma discipline', async () => {
    const goFile = join(dir, 'go');
    const racers = [0, 1, 2, 3].map(() =>
      execFileAsync(process.execPath, ['--import', 'tsx', CHILD, dbPath, goFile], {
        timeout: 120_000,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(goFile, 'go');

    const results = (await Promise.all(racers)).map(
      (r) =>
        JSON.parse(r.stdout) as {
          ok: boolean;
          message?: string;
          journal_mode: string;
          busy_timeout: number;
        },
    );

    // Losing the race must not mean losing the settings: a connection that
    // silently ran without WAL or without a busy timeout would be the one that
    // corrupts or blocks later.
    for (const result of results) {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.journal_mode.toLowerCase()).toBe('wal');
      expect(result.busy_timeout).toBe(5000);
    }
  }, 180_000);

  it('reports the same pragmas from a single opener too', () => {
    const { db } = openDatabase(dbPath);
    try {
      expect(String(Object.values(db.get('PRAGMA journal_mode') ?? {})[0]).toLowerCase()).toBe(
        'wal',
      );
      expect(Number(Object.values(db.get('PRAGMA busy_timeout') ?? {})[0])).toBe(5000);
      expect(Number(Object.values(db.get('PRAGMA foreign_keys') ?? {})[0])).toBe(1);
      // trusted_schema off: a schema in the file cannot run functions during a
      // read, which is what makes opening someone else's database safe.
      expect(Number(Object.values(db.get('PRAGMA trusted_schema') ?? {})[0])).toBe(0);
    } finally {
      db.close();
    }
  });
});
