import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  detectConflicts,
  getClaim,
  listConflicts,
  proposeClaim,
  resolveConflict,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let artifactId: string;
let conflictId: string;
let claimA: string;
let claimB: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-disp-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
  claimA = proposeClaim(db, {
    statement: 'The project work tree contains 339 files.',
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'parser',
  }).id;
  claimB = proposeClaim(db, {
    statement: 'The project work tree contains 316 files.',
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'parser',
  }).id;
  conflictId = detectConflicts(db).created[0]!;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('conflict resolution requires a decision per member', () => {
  it('refuses to resolve while any member claim is undecided', () => {
    // This is the exact regression: previously a note alone closed the
    // conflict and both contradictory claims stayed live.
    try {
      resolveConflict(db, {
        conflict_id: conflictId,
        resolution: 'resolved',
        note: '316',
        confirm: true,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('INVALID_INPUT');
      expect((err as DomainError).blockers).toEqual(
        expect.arrayContaining([`undecided:${claimA}`, `undecided:${claimB}`]),
      );
    }
    expect(listConflicts(db, { state: 'open' })).toHaveLength(1);
  });

  it('refuses partial decisions', () => {
    expect(() =>
      resolveConflict(db, {
        conflict_id: conflictId,
        resolution: 'resolved',
        note: 'only decided one',
        member_actions: [{ claim_id: claimB, action: 'verify' }],
        confirm: true,
      }),
    ).toThrowError(DomainError);
  });

  it('rejects member actions naming claims outside the conflict', () => {
    const outsider = proposeClaim(db, {
      statement: 'An unrelated statement with no numbers at all here.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    }).id;
    expect(() =>
      resolveConflict(db, {
        conflict_id: conflictId,
        resolution: 'resolved',
        note: 'wrong members',
        member_actions: [
          { claim_id: claimA, action: 'reject', reason: 'stale' },
          { claim_id: claimB, action: 'verify' },
          { claim_id: outsider, action: 'verify' },
        ],
        confirm: true,
      }),
    ).toThrowError(DomainError);
  });

  it('resolves when every member has a disposition', () => {
    const conflict = resolveConflict(db, {
      conflict_id: conflictId,
      resolution: 'resolved',
      note: 're-scanned: 316 is correct',
      member_actions: [
        { claim_id: claimA, action: 'reject', reason: 'counted cache directories' },
        { claim_id: claimB, action: 'verify' },
      ],
      confirm: true,
    });
    expect(conflict.state).toBe('resolved');
    expect(getClaim(db, claimA).state).toBe('rejected');
    expect(getClaim(db, claimB).state).toBe('verified');
  });

  it('still allows dismissal without dispositions when the members do not really conflict', () => {
    const conflict = resolveConflict(db, {
      conflict_id: conflictId,
      resolution: 'dismissed',
      note: 'different repositories, not a contradiction',
      confirm: true,
    });
    expect(conflict.state).toBe('dismissed');
    expect(getClaim(db, claimA).state).toBe('candidate');
  });
});
