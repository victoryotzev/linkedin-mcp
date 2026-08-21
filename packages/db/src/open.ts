import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NodeSqliteDriver, type SqliteDriver } from './driver.ts';

export interface OpenResult {
  db: SqliteDriver;
  fts5: boolean;
}

// Every process (MCP server, dashboard, tests) opens the database through this
// function so pragma discipline is identical everywhere.
export function openDatabase(path: string): OpenResult {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new NodeSqliteDriver(path);
  // busy_timeout first, so every statement below it waits rather than failing.
  db.exec('PRAGMA busy_timeout = 5000');
  enableWal(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA trusted_schema = OFF');
  return { db, fts5: checkFts5(db) };
}

const WAL_SWITCH_RETRIES = 40;
const WAL_SWITCH_WAIT_MS = 25;

function journalMode(db: SqliteDriver): string {
  return String(Object.values(db.get('PRAGMA journal_mode') ?? {})[0] ?? '').toLowerCase();
}

function isLockedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { errcode?: number }).errcode;
  return code === 5 || code === 6 || /database is locked|SQLITE_BUSY/i.test(err.message);
}

/** Blocks this thread. The driver is synchronous, so there is nothing to await. */
function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Switching to WAL takes a brief exclusive lock, and this product opens one
// home from two processes: the MCP server and the dashboard. A member who
// launches the dashboard while their MCP host is starting hits exactly that.
//
// Two things make it survivable. Reading the current mode costs no lock, and
// after the very first open the database is already WAL — which is the case
// that actually happens, since a home is created once and opened many times.
// And for a genuine first-time race, the wait has to be explicit: SQLite
// answers a contended journal_mode change with SQLITE_BUSY straight away rather
// than running the busy handler, so busy_timeout does not cover this one.
//
// Exported for the same reason it is careful: this is where the concurrent-open
// bug lived, and its retry and give-up paths cannot be reached from a real
// database on demand. openDatabase is the only caller in the product.
export function enableWal(db: SqliteDriver): void {
  if (journalMode(db) === 'wal') return;

  for (let attempt = 0; attempt <= WAL_SWITCH_RETRIES; attempt++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!isLockedError(err)) throw err;
      // Another opener is mid-switch. It is setting the same mode this one
      // wants, so finding WAL in place is success, not a race lost.
      if (journalMode(db) === 'wal') return;
      if (attempt === WAL_SWITCH_RETRIES) throw err;
      waitSync(WAL_SWITCH_WAIT_MS);
    }
  }
  // The loop returns on success and throws on the last attempt, so falling out
  // of it is unreachable. Kept as the function's closing shape rather than
  // restructured: the bound and the throw are what make the give-up explicit.
  /* v8 ignore next */
}

// Search is a convenience, not a safety function: when FTS5 is unavailable the
// caller degrades to LIKE search and logs to stderr. Publishing paths never
// depend on FTS.
//
// Exported alongside enableWal: every SQLite build this product runs on has
// FTS5, so the fallback is only observable through an injected driver.
export function checkFts5(db: SqliteDriver): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)');
    db.exec('DROP TABLE temp.__fts5_probe');
    return true;
  } catch {
    return false;
  }
}
