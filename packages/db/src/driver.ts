import type { DatabaseSync } from 'node:sqlite';

// Acquired via process.getBuiltinModule instead of a static import: esbuild's
// builtin list predates node:sqlite and rewrites the import to a bare
// 'sqlite' package when bundling. getBuiltinModule bypasses bundler
// resolution entirely (that is what the API exists for).
const { DatabaseSync: DatabaseSyncImpl, backup } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');

// Thin seam over the SQLite driver so the rest of the codebase never touches
// node:sqlite directly. If node:sqlite ever blocks us, better-sqlite3 slots in
// behind this interface without touching domain code (plan PR7).
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteDriver {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get(sql: string, ...params: SqlValue[]): Row | undefined;
  all(sql: string, ...params: SqlValue[]): Row[];
  backupTo(destPath: string): Promise<void>;
  close(): void;
}

export class NodeSqliteDriver implements SqliteDriver {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSyncImpl(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    const result = this.#db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SqlValue[]): Row[] {
    return this.#db.prepare(sql).all(...params) as Row[];
  }

  async backupTo(destPath: string): Promise<void> {
    await backup(this.#db, destPath);
  }

  close(): void {
    this.#db.close();
  }
}

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { errcode?: number }).errcode;
  // SQLITE_BUSY = 5, SQLITE_BUSY_SNAPSHOT = 517
  if (code === 5 || code === 517) return true;
  return /database is locked|SQLITE_BUSY/i.test(err.message);
}

const BUSY_RETRIES = 3;
const IN_TX = new WeakSet<SqliteDriver>();

// All writes go through an IMMEDIATE transaction: the write lock is taken up
// front, which removes lock-upgrade deadlocks between the MCP server and the
// dashboard sharing this database. Re-entrant: a service composing other
// services inside its own withWriteTx joins the outer transaction (SQLite has
// no nested BEGIN; the outer commit/rollback governs everything).
/**
 * Runs `fn` inside a BEGIN IMMEDIATE transaction, retrying on SQLITE_BUSY.
 *
 * CONTRACT: `fn` must be safe to run more than once. A busy error raised from
 * inside `fn` rolls the transaction back and re-runs `fn` from the top, so the
 * database is consistent — but anything `fn` did OUTSIDE the database is not
 * undone and will happen again. No filesystem writes or deletes, no network
 * calls, no mutation of closure state that the caller reads afterwards. Do that
 * work after this function returns.
 *
 * Re-entrant: a nested call joins the open transaction instead of starting a
 * second one.
 */
export function withWriteTx<T>(db: SqliteDriver, fn: () => T): T {
  if (IN_TX.has(db)) return fn();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = 50 * attempt + Math.floor(Math.random() * 100);
      const until = Date.now() + backoffMs;
      while (Date.now() < until) {
        // Synchronous driver: a short blocking backoff is acceptable here.
      }
    }
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusyError(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    IN_TX.add(db);
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Connection-level failure during rollback: surface the original error.
      }
      if (isBusyError(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    } finally {
      IN_TX.delete(db);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('withWriteTx: retries exhausted');
}
