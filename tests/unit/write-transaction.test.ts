import { describe, expect, it } from 'vitest';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';

// The write transaction, and what it does when the lock is not available.
//
// Every write in this product goes through here. Two processes share one
// database — the MCP server and the dashboard — so contention is the normal
// case rather than the exceptional one, and what happens under it decides
// whether a member loses a write or merely waits for one.
//
// A hand-built driver rather than a real database: the point is the retry and
// rollback logic around the calls, and a fake is the only way to make BEGIN
// fail on demand.

function busy(message = 'database is locked'): Error & { errcode?: number } {
  return Object.assign(new Error(message), { errcode: 5 });
}

interface FakeDriver extends SqliteDriver {
  calls: string[];
}

/** A driver whose `BEGIN IMMEDIATE` fails the first `failures` times. */
function fakeDriver(options: { beginFailures?: number; commitFails?: boolean } = {}): FakeDriver {
  const calls: string[] = [];
  let beginsLeftToFail = options.beginFailures ?? 0;

  const driver = {
    calls,
    exec(sql: string) {
      calls.push(sql);
      if (sql === 'BEGIN IMMEDIATE' && beginsLeftToFail > 0) {
        beginsLeftToFail -= 1;
        throw busy();
      }
      if (sql === 'COMMIT' && options.commitFails) throw busy();
    },
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => [],
    close: () => {},
  } as unknown as FakeDriver;
  return driver;
}

describe('an uncontended write', () => {
  it('runs inside one transaction and commits', () => {
    const db = fakeDriver();

    const result = withWriteTx(db, () => 'done');

    expect(result).toBe('done');
    expect(db.calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  it('takes the write lock up front rather than upgrading later', () => {
    const db = fakeDriver();
    withWriteTx(db, () => null);

    // BEGIN IMMEDIATE, not BEGIN: a deferred transaction that upgrades its lock
    // mid-way is how two writers deadlock.
    expect(db.calls[0]).toBe('BEGIN IMMEDIATE');
  });
});

describe('a nested write', () => {
  it('joins the transaction already open rather than starting a second', () => {
    const db = fakeDriver();

    const result = withWriteTx(db, () => withWriteTx(db, () => withWriteTx(db, () => 'innermost')));

    expect(result).toBe('innermost');
    // One BEGIN and one COMMIT for the whole nest: SQLite has no real nested
    // transactions, and a service composing other services must not commit
    // half of its caller's work.
    expect(db.calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  it('lets the outer transaction roll the whole nest back', () => {
    const db = fakeDriver();

    expect(() =>
      withWriteTx(db, () => {
        withWriteTx(db, () => 'inner did some work');
        throw new Error('the outer step failed');
      }),
    ).toThrow(/outer step failed/);

    expect(db.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});

describe('a write that fails', () => {
  it('rolls back and surfaces the original error', () => {
    const db = fakeDriver();

    expect(() =>
      withWriteTx(db, () => {
        throw new Error('the domain refused');
      }),
    ).toThrow(/the domain refused/);

    expect(db.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('still surfaces the original error when the rollback itself fails', () => {
    const calls: string[] = [];
    const db = {
      exec(sql: string) {
        calls.push(sql);
        if (sql === 'ROLLBACK') throw new Error('connection is gone');
      },
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
      close: () => {},
    } as unknown as SqliteDriver;

    // A connection-level failure during rollback tells the caller nothing
    // useful; what went wrong is the error their own code threw.
    expect(() =>
      withWriteTx(db, () => {
        throw new Error('the domain refused');
      }),
    ).toThrow(/the domain refused/);
    expect(calls).toContain('ROLLBACK');
  });
});

describe('a write that has to wait for the lock', () => {
  it('retries and succeeds once the lock frees', () => {
    const db = fakeDriver({ beginFailures: 2 });

    const result = withWriteTx(db, () => 'eventually');

    expect(result).toBe('eventually');
    // Three attempts at BEGIN, one COMMIT: the caller never sees the contention.
    expect(db.calls.filter((c) => c === 'BEGIN IMMEDIATE')).toHaveLength(3);
    expect(db.calls.filter((c) => c === 'COMMIT')).toHaveLength(1);
  });

  it('gives up after a bounded number of attempts rather than blocking forever', () => {
    const db = fakeDriver({ beginFailures: 99 });

    expect(() => withWriteTx(db, () => 'never')).toThrow(/database is locked/i);

    // Bounded: a member waiting on a lock that is never coming back needs an
    // error, not a hung process.
    expect(db.calls.filter((c) => c === 'BEGIN IMMEDIATE').length).toBeLessThan(10);
  });

  it('never runs the body for an attempt whose BEGIN failed', () => {
    const db = fakeDriver({ beginFailures: 2 });
    let bodyRuns = 0;

    withWriteTx(db, () => {
      bodyRuns += 1;
      return null;
    });

    // The body has side effects outside the database that a rollback cannot
    // undo, so it must not run speculatively.
    expect(bodyRuns).toBe(1);
  });

  it('re-runs the body when the commit itself hits the lock', () => {
    const db = fakeDriver({ commitFails: true });
    let bodyRuns = 0;

    expect(() =>
      withWriteTx(db, () => {
        bodyRuns += 1;
        return null;
      }),
    ).toThrow();

    // This is why the contract says the body must be safe to run more than
    // once: a busy COMMIT rolls back and starts again from the top.
    expect(bodyRuns).toBeGreaterThan(1);
  });
});

describe('what counts as contention', () => {
  it('retries a locked database', () => {
    const db = fakeDriver({ beginFailures: 1 });
    expect(withWriteTx(db, () => 'ok')).toBe('ok');
  });

  it('does not retry an error that is not contention', () => {
    const calls: string[] = [];
    const db = {
      exec(sql: string) {
        calls.push(sql);
        if (sql === 'BEGIN IMMEDIATE') throw new Error('no such table: claims');
      },
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
      close: () => {},
    } as unknown as SqliteDriver;

    // Retrying a schema error would turn an immediate, clear failure into a
    // slow one that says the same thing.
    expect(() => withWriteTx(db, () => null)).toThrow(/no such table/);
    expect(calls.filter((c) => c === 'BEGIN IMMEDIATE')).toHaveLength(1);
  });
});
