// Child process for the two-process WAL contention gate (plan P0/PR7).
// Usage: node --import tsx wal-child.ts <dbPath> <writerId> <rowCount>
//
// This deliberately drives the REAL driver seam — openDatabase (which applies
// the production pragmas) and withWriteTx (which owns BEGIN IMMEDIATE, the
// SQLITE_BUSY retry and the rollback path). The previous version hand-rolled
// its own DatabaseSync, its own pragmas and its own retry loop, so it proved
// that SQLite handles WAL contention, not that OUR code does — which is the
// only thing the gate exists to establish.
import { openDatabase, withWriteTx } from '@linkedin-mcp/db';

const [dbPath, writerId, rowCountArg] = process.argv.slice(2);
const rowCount = Number.parseInt(rowCountArg!, 10);

const { db } = openDatabase(dbPath!);

// A writer that exhausts its bounded retry budget under saturation has not
// lost data — it has correctly refused to proceed without the write lock. The
// child records where it stopped rather than dying, so the parent can assert
// the invariant that actually matters (every row it claims to have committed
// is really there, contiguously) instead of failing on a scheduling accident.
let gaveUpAt: number | null = null;

for (let i = 0; i < rowCount; i++) {
  try {
    withWriteTx(db, () => {
      db.run('INSERT INTO contention (writer, seq) VALUES (?, ?)', writerId!, i);
      // Re-entrancy under contention: a nested call must join the open
      // transaction rather than starting a second BEGIN IMMEDIATE, and the
      // WeakSet guard must survive the retry path.
      withWriteTx(db, () => {
        db.run('UPDATE contention SET checked = 1 WHERE writer = ? AND seq = ?', writerId!, i);
      });
    });
  } catch (err) {
    if (!/database is locked|SQLITE_BUSY|retries exhausted/i.test(String(err))) throw err;
    gaveUpAt = i;
    break;
  }
}

// Measured, not echoed. The old child reported back the rowCount it was handed
// on argv and the parent asserted on that, which is true no matter what the
// database did.
const committed = db.get(
  'SELECT COUNT(*) AS n FROM contention WHERE writer = ? AND checked = 1',
  writerId!,
);
db.close();
process.stdout.write(
  JSON.stringify({ writerId, committed: Number(committed?.['n'] ?? -1), gaveUpAt }),
);
