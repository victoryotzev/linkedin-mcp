import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import {
  detectConflicts,
  getClaim,
  listConflicts,
  proposeClaim,
  resolveConflict,
} from '@linkedin-mcp/domain';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let artifactId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-cfl-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('conflict detection & resolution', () => {
  it('detects numeric contradictions between claims sharing a metric signature', () => {
    const a = proposeClaim(db, {
      statement: 'The project has 187 test files.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    const b = proposeClaim(db, {
      statement: 'The project has 203 test files.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'model_proposed',
    });
    const { created } = detectConflicts(db);
    expect(created).toHaveLength(1);

    const conflicts = listConflicts(db, { state: 'open' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.type).toBe('contradiction');
    expect(conflicts[0]!.members.map((m) => m.claim_id).sort()).toEqual([a.id, b.id].sort());

    // Re-running detection does not duplicate the open conflict.
    expect(detectConflicts(db).created).toHaveLength(0);
  });

  it('resolves atomically with member transitions; invalid transitions roll everything back', () => {
    const a = proposeClaim(db, {
      statement: 'Repo contains 40 TypeScript source files.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    const b = proposeClaim(db, {
      statement: 'Repo contains 45 TypeScript source files.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'model_proposed',
    });
    const conflictId = detectConflicts(db).created[0]!;

    const resolved = resolveConflict(db, {
      conflict_id: conflictId,
      resolution: 'resolved',
      note: 'recounted: 40 is correct',
      member_actions: [
        { claim_id: a.id, action: 'verify' },
        { claim_id: b.id, action: 'reject', reason: 'stale count' },
      ],
      confirm: true,
    });
    expect(resolved.state).toBe('resolved');
    expect(getClaim(db, a.id).state).toBe('verified');
    expect(getClaim(db, b.id).state).toBe('rejected');
  });

  // The previous version passed an unknown claim id as the second action, which
  // tripped the PRE-WRITE undecided-members validation — so nothing had been
  // written and there was nothing to roll back. It would have passed with the
  // transaction removed entirely. Here both ids belong to the conflict, so
  // validation succeeds and the SECOND action fails mid-write: claim b has only
  // corroborating evidence, so verifying it throws EVIDENCE_NOT_VERIFIED after
  // claim a has already been verified inside the same transaction.
  it('rolls back the whole resolution when a member action fails', () => {
    const a = proposeClaim(db, {
      statement: 'Site serves 4 image formats.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    const b = proposeClaim(db, {
      statement: 'Site serves 6 image formats.',
      evidence: [{ artifact_id: artifactId, location: {}, role: 'corroborating' }],
      method: 'parser',
    });
    const conflictId = detectConflicts(db).created[0]!;

    let code = 'NO_ERROR';
    try {
      resolveConflict(db, {
        conflict_id: conflictId,
        resolution: 'resolved',
        note: 'attempt',
        member_actions: [
          { claim_id: a.id, action: 'verify' },
          { claim_id: b.id, action: 'verify' },
        ],
        confirm: true,
      });
    } catch (err) {
      code = err instanceof DomainError ? err.code : 'NON_DOMAIN_ERROR';
    }
    // Asserted explicitly: the throw must come from the second action failing
    // mid-write, not from a pre-write validation that never touched the database.
    expect(code).toBe('EVIDENCE_NOT_VERIFIED');

    // Atomicity: a's verify was rolled back, conflict stays open.
    expect(getClaim(db, a.id).state).toBe('candidate');
    expect(getClaim(db, b.id).state).toBe('candidate');
    expect(listConflicts(db, { state: 'open' })).toHaveLength(1);
  });
});
