import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  amendClaimLimitations,
  getClaim,
  proposeClaim,
  rejectClaim,
  verifyClaim,
} from '@linkedin-mcp/domain';
import type { DomainError } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let artifactId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-amend-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function makeClaim(statement: string) {
  return proposeClaim(db, {
    statement,
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'manual',
    limitations: 'CONFLICT: do not publish until reconciled.',
  });
}

describe('amendClaimLimitations', () => {
  it('updates wording constraints without touching statement or state', () => {
    const claim = makeClaim('A statement whose wording constraint changes later.');
    verifyClaim(db, { claim_id: claim.id, confirm: true });

    const amended = amendClaimLimitations(db, {
      claim_id: claim.id,
      limitations: 'RESOLVED: the CV is authoritative.',
      reviewer: 'user:test',
    });
    expect(amended.limitations).toBe('RESOLVED: the CV is authoritative.');
    expect(amended.statement).toBe(claim.statement);
    expect(amended.state).toBe('verified');
    expect(getClaim(db, claim.id).reviewed_at).not.toBeNull();
  });

  it('can clear limitations', () => {
    const claim = makeClaim('Another statement with a constraint to clear.');
    expect(
      amendClaimLimitations(db, { claim_id: claim.id, limitations: null }).limitations,
    ).toBeNull();
  });

  it('refuses to amend rejected tombstones', () => {
    const claim = makeClaim('A statement that gets rejected outright.');
    rejectClaim(db, {
      claim_id: claim.id,
      reason: 'not supported',
      confirm: true,
      reviewer: 'test',
    });
    try {
      amendClaimLimitations(db, { claim_id: claim.id, limitations: 'anything' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('TERMINAL_STATE');
    }
  });
});
