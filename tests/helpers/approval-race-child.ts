// One racer in the single-use-approval race (plan PR5 acceptance criterion:
// two processes, one approval, N racers, exactly one success).
//
// It has to be a separate OS process. The driver is synchronous, the approval
// is consumed inside a withWriteTx that completes before the publisher is ever
// awaited, and the idempotency key is derived from the approval — so within one
// process the second call always short-circuits on the idempotency SELECT and
// the conditional UPDATE that actually guards against double-publishing is
// never executed.
//
// Usage: node --import tsx approval-race-child.ts <dbPath> <approvalId> <goFile>
import { existsSync } from 'node:fs';
import { openDatabase } from '@linkedin-mcp/db';
import { executePublication } from '@linkedin-mcp/domain';
import { DryRunPublisher } from '@linkedin-mcp/linkedin';

const [dbPath, approvalId, goFile] = process.argv.slice(2);
const { db } = openDatabase(dbPath!);

// Barrier: every racer opens its connection first, then spins until the parent
// releases them together, so they collide inside the transaction rather than
// trickling in as each process finishes booting.
const deadline = Date.now() + 30_000;
while (!existsSync(goFile!) && Date.now() < deadline) {
  // Intentional busy-wait: any sleep here would stagger the racers.
}

let result: Record<string, unknown>;
try {
  const publication = await executePublication(db, new DryRunPublisher(), {
    approval_id: approvalId!,
  });
  result = { ok: true, publication_id: publication.id, outcome: publication.outcome };
} catch (err) {
  result = {
    ok: false,
    code: (err as { code?: string }).code ?? 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };
}

db.close();
process.stdout.write(JSON.stringify(result));
