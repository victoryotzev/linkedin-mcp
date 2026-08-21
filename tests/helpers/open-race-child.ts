// One racer in the concurrent-open race.
//
// It has to be a separate OS process: within one process the pragmas run
// sequentially on connections that already exist, so nothing contends.
//
// Usage: node --import tsx open-race-child.ts <dbPath> <goFile>
import { existsSync } from 'node:fs';
import { openDatabase } from '@linkedin-mcp/db';

const [dbPath, goFile] = process.argv.slice(2);

// Barrier: every racer boots first, then they are released together so their
// pragma sequences overlap rather than trickling in one at a time.
const deadline = Date.now() + 30_000;
while (!existsSync(goFile!) && Date.now() < deadline) {
  // Intentional busy-wait: a sleep here would stagger the racers.
}

let result: Record<string, unknown>;
try {
  const { db, fts5 } = openDatabase(dbPath!);
  const mode = db.get('PRAGMA journal_mode');
  const timeout = db.get('PRAGMA busy_timeout');
  result = {
    ok: true,
    journal_mode: String(Object.values(mode ?? {})[0] ?? ''),
    busy_timeout: Number(Object.values(timeout ?? {})[0] ?? 0),
    fts5,
  };
  db.close();
} catch (err) {
  result = { ok: false, message: err instanceof Error ? err.message : String(err) };
}

process.stdout.write(JSON.stringify(result));
