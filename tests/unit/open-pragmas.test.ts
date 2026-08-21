import { describe, expect, it } from 'vitest';
import { checkFts5, enableWal, type SqliteDriver } from '@linkedin-mcp/db';

// The pragma discipline every process shares, and what it does when the
// database will not cooperate.
//
// This is where the concurrent-open bug lived: the MCP server and the dashboard
// both open one home, and the loser of the journal_mode race used to die with a
// raw "database is locked". Its retry and give-up paths cannot be reached from
// a real database on demand, so they are driven through an injected driver.

function locked(message = 'database is locked', errcode = 5): Error {
  return Object.assign(new Error(message), { errcode });
}

interface FakeDriver extends SqliteDriver {
  calls: string[];
}

function fakeDriver(options: {
  /** Mode reported by `PRAGMA journal_mode`, as a sequence of answers. */
  modes?: string[];
  /** How many `PRAGMA journal_mode = WAL` statements fail before one succeeds. */
  switchFailures?: number;
  switchError?: Error;
  fts5?: boolean;
}): FakeDriver {
  const calls: string[] = [];
  const modes = [...(options.modes ?? ['delete'])];
  let failuresLeft = options.switchFailures ?? 0;

  return {
    calls,
    exec(sql: string) {
      calls.push(sql);
      if (sql === 'PRAGMA journal_mode = WAL' && failuresLeft > 0) {
        failuresLeft -= 1;
        throw options.switchError ?? locked();
      }
      if (sql.includes('fts5') && options.fts5 === false) {
        throw new Error('no such module: fts5');
      }
    },
    get(sql: string) {
      calls.push(sql);
      if (sql === 'PRAGMA journal_mode') {
        return { journal_mode: modes.length > 1 ? modes.shift() : modes[0] };
      }
      return undefined;
    },
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    all: () => [],
    close: () => {},
  } as unknown as FakeDriver;
}

const switchAttempts = (db: FakeDriver) =>
  db.calls.filter((c) => c === 'PRAGMA journal_mode = WAL').length;

describe('a database that is already in WAL', () => {
  it('is left alone, taking no lock at all', () => {
    const db = fakeDriver({ modes: ['wal'] });

    enableWal(db);

    // This is the case that actually happens: a home is created once and opened
    // many times, so after the first open nobody switches anything.
    expect(switchAttempts(db)).toBe(0);
  });

  it('is recognised whatever case SQLite reports', () => {
    const db = fakeDriver({ modes: ['WAL'] });
    enableWal(db);
    expect(switchAttempts(db)).toBe(0);
  });
});

describe('a database that still has to be switched', () => {
  it('switches it once when nothing is in the way', () => {
    const db = fakeDriver({ modes: ['delete'] });

    enableWal(db);

    expect(switchAttempts(db)).toBe(1);
  });

  it('waits and retries while another opener holds the lock', () => {
    const db = fakeDriver({ modes: ['delete'], switchFailures: 2 });

    enableWal(db);

    // Three attempts, no error: the caller never sees the contention.
    expect(switchAttempts(db)).toBe(3);
  });

  it('treats finding WAL already set as success, not as a race lost', () => {
    // The switch fails, and by the time the mode is re-read the other opener
    // has finished — it was setting the same mode this one wanted.
    const db = fakeDriver({ modes: ['delete', 'wal'], switchFailures: 99 });

    expect(() => enableWal(db)).not.toThrow();
    expect(switchAttempts(db)).toBe(1);
  });

  it('gives up eventually rather than spinning forever', () => {
    const db = fakeDriver({ modes: ['delete'], switchFailures: 999 });

    // A lock that is never coming back has to surface as an error. Bounded, so
    // a member gets a message rather than a process that never starts.
    expect(() => enableWal(db)).toThrow(/database is locked/i);
    expect(switchAttempts(db)).toBeLessThan(100);
  });

  it('recognises contention by error code as well as by message', () => {
    // node:sqlite reports SQLITE_BUSY as errcode 5 and SQLITE_LOCKED as 6; the
    // message text is not guaranteed to say either.
    for (const errcode of [5, 6]) {
      const db = fakeDriver({
        modes: ['delete'],
        switchFailures: 1,
        switchError: Object.assign(new Error('constraint failed'), { errcode }),
      });
      expect(() => enableWal(db), String(errcode)).not.toThrow();
    }
  });

  it('does not retry an error that has nothing to do with contention', () => {
    const db = fakeDriver({
      modes: ['delete'],
      switchFailures: 99,
      switchError: new Error('attempt to write a readonly database'),
    });

    // A read-only file will never become writable by waiting, and retrying
    // would turn a clear failure into a slow one saying the same thing.
    expect(() => enableWal(db)).toThrow(/readonly/);
    expect(switchAttempts(db)).toBe(1);
  });

  it('rethrows something that is not an Error at all', () => {
    const db = fakeDriver({ modes: ['delete'] });
    const throwing = {
      ...db,
      exec(sql: string) {
        if (sql === 'PRAGMA journal_mode = WAL') throw 'a bare string';
        db.exec(sql);
      },
      get: db.get.bind(db),
    } as unknown as SqliteDriver;

    expect(() => enableWal(throwing)).toThrow();
  });
});

describe('the full-text search probe', () => {
  it('reports it as available when the module loads', () => {
    expect(checkFts5(fakeDriver({ modes: ['wal'] }))).toBe(true);
  });

  it('reports it as unavailable rather than failing the open', () => {
    // Search degrades to LIKE without FTS5 and no safety path depends on it, so
    // a build without the module still opens.
    expect(checkFts5(fakeDriver({ modes: ['wal'], fts5: false }))).toBe(false);
  });

  it('cleans up its probe table when the module is there', () => {
    const db = fakeDriver({ modes: ['wal'] });
    checkFts5(db);

    // Left behind, the temp table would collide with the next probe on the same
    // connection.
    expect(db.calls).toContain('DROP TABLE temp.__fts5_probe');
  });
});
