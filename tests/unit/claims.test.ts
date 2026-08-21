import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  getClaim,
  listClaims,
  markClaimAmbiguous,
  mergeClaim,
  proposeClaim,
  rejectClaim,
  runRetentionSweep,
  verifyClaim,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let artifactId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-claims-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

const EVIDENCE = () => [{ artifact_id: artifactId, location: { lines: [1, 5] } }];

describe('claim lifecycle', () => {
  it('requires confirmation for destructive dispositions and records the real reviewer', () => {
    const claim = proposeClaim(db, {
      statement: 'A reviewed claim can be rejected only by explicit decision.',
      evidence: EVIDENCE(),
      method: 'manual',
    });
    expect(
      codeOf(() =>
        rejectClaim(db, {
          claim_id: claim.id,
          reason: 'evidence was withdrawn',
          confirm: false,
          reviewer: 'mcp_host',
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(getClaim(db, claim.id).state).toBe('candidate');

    const ambiguous = markClaimAmbiguous(db, {
      claim_id: claim.id,
      confirm: true,
      reviewer: 'mcp_host',
      note: 'needs another source',
    });
    expect(ambiguous.state).toBe('ambiguous');
    expect(ambiguous.reviewed_by).toBe('mcp_host');
  });

  it('proposes candidates and verifies them with confirm', () => {
    const claim = proposeClaim(db, {
      statement: 'The ERP project has 181 test files.',
      evidence: EVIDENCE(),
      method: 'parser',
    });
    expect(claim.state).toBe('candidate');

    expect(codeOf(() => verifyClaim(db, { claim_id: claim.id, confirm: false }))).toBe(
      'INVALID_INPUT',
    );
    const verified = verifyClaim(db, {
      claim_id: claim.id,
      confirm: true,
      limitations: 'repo count, not CI count',
    });
    expect(verified.state).toBe('verified');
    expect(verified.limitations).toContain('repo count');
  });

  it('dedups active statements and blocks tombstone resurrection', () => {
    const claim = proposeClaim(db, {
      statement: 'Built a cPanel MCP server with ~60 tools.',
      evidence: EVIDENCE(),
      method: 'manual',
    });
    // Restyled duplicate (case/whitespace) collides.
    expect(
      codeOf(() =>
        proposeClaim(db, {
          statement: '  built a CPANEL mcp SERVER with ~60 tools. ',
          evidence: EVIDENCE(),
          method: 'manual',
        }),
      ),
    ).toBe('INVALID_INPUT');

    rejectClaim(db, {
      claim_id: claim.id,
      reason: 'tool count not yet reverified',
      confirm: true,
      reviewer: 'test',
    });
    expect(
      codeOf(() =>
        proposeClaim(db, {
          statement: 'Built a cPanel MCP server with ~60 tools.',
          evidence: EVIDENCE(),
          method: 'parser',
        }),
      ),
    ).toBe('CLAIM_REJECTED_TOMBSTONE');
  });

  it('refuses verification without primary evidence', () => {
    const claim = proposeClaim(db, {
      statement: 'Some corroborated-only statement here.',
      evidence: [{ artifact_id: artifactId, location: {}, role: 'corroborating' }],
      method: 'manual',
    });
    expect(codeOf(() => verifyClaim(db, { claim_id: claim.id, confirm: true }))).toBe(
      'EVIDENCE_NOT_VERIFIED',
    );
  });

  describe('clone-reference evidence', () => {
    const cloneClaim = (statement: string, artifactId: string) =>
      proposeClaim(db, {
        statement,
        evidence: [{ artifact_id: artifactId, location: {} }],
        method: 'model_proposed',
      });

    it('hard-blocks credit language, with no acknowledgement override', () => {
      const clone = seedSourceAndArtifact(db, {
        trust: 'local_clone_reference',
        label: 'blender_mcp clone',
      });
      const claim = cloneClaim(
        'I contributed features to the Blender MCP server.',
        clone.artifactId,
      );
      // Not even an explicit acknowledgement makes "I contributed" true of
      // someone else's repository.
      expect(
        codeOf(() =>
          verifyClaim(db, { claim_id: claim.id, confirm: true, clone_reference_ack: true }),
        ),
      ).toBe('EVIDENCE_NOT_VERIFIED');
      expect(getClaim(db, claim.id).state).toBe('candidate');
    });

    // Each of these slipped past the original verb list. They are the reason the
    // acknowledgement gate exists as well as the regex.
    it.each([
      'Creator of the Blender MCP server.',
      'Lead maintainer of the Blender MCP integration.',
      'Rewrote the Blender MCP scheduler for throughput.',
      'Ported the Blender MCP server to Windows.',
      'Owner of the Blender MCP tool catalogue.',
      'Architected the Blender MCP socket layer.',
    ])('hard-blocks %j', (statement) => {
      const clone = seedSourceAndArtifact(db, { trust: 'local_clone_reference' });
      const claim = cloneClaim(statement, clone.artifactId);
      expect(codeOf(() => verifyClaim(db, { claim_id: claim.id, confirm: true }))).toBe(
        'EVIDENCE_NOT_VERIFIED',
      );
    });

    it('requires an explicit acknowledgement for anything else on clone evidence', () => {
      const clone = seedSourceAndArtifact(db, { trust: 'local_clone_reference' });
      const familiarity = cloneClaim(
        'The Blender MCP server exposes Python API docs over a TCP socket.',
        clone.artifactId,
      );

      // Fail-closed: no word list is trusted to tell familiarity from credit.
      expect(codeOf(() => verifyClaim(db, { claim_id: familiarity.id, confirm: true }))).toBe(
        'EVIDENCE_NOT_VERIFIED',
      );
      expect(getClaim(db, familiarity.id).state).toBe('candidate');

      const verified = verifyClaim(db, {
        claim_id: familiarity.id,
        confirm: true,
        clone_reference_ack: true,
      });
      expect(verified.state).toBe('verified');
      // The assertion becomes a permanent wording constraint that travels with
      // the claim into every patch and draft that cites it.
      expect(verified.limitations).toContain('familiarity only');
    });

    it('leaves claims backed by the member’s own repositories alone', () => {
      const own = seedSourceAndArtifact(db, { trust: 'own_repo' });
      const claim = cloneClaim(
        'I built the cPanel MCP server in strict TypeScript.',
        own.artifactId,
      );
      expect(verifyClaim(db, { claim_id: claim.id, confirm: true }).state).toBe('verified');
      expect(getClaim(db, claim.id).limitations).toBeNull();
    });
  });

  it('expires stale verified claims via the retention sweep', () => {
    const claim = proposeClaim(db, {
      statement: 'A statement that goes stale quickly.',
      evidence: EVIDENCE(),
      method: 'manual',
      review_by: '2026-01-01T00:00:00Z',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });
    const report = runRetentionSweep(db, new Date('2026-08-08T00:00:00Z'));
    expect(report.claims_expired).toBe(1);
    expect(getClaim(db, claim.id).state).toBe('expired');
  });

  it('merges claims and carries evidence over as corroboration', () => {
    const a = proposeClaim(db, {
      statement: 'The portfolio site ships Playwright tests.',
      evidence: EVIDENCE(),
      method: 'parser',
    });
    const b = proposeClaim(db, {
      statement: 'Portfolio regression tests run across five device profiles.',
      evidence: EVIDENCE(),
      method: 'parser',
    });
    const merged = mergeClaim(db, {
      claim_id: a.id,
      merge_into: b.id,
      confirm: true,
      reviewer: 'test',
    });
    expect(merged.state).toBe('expired');
    expect(merged.merged_into).toBe(b.id);
    expect(listClaims(db, { state: 'candidate' }, false)).toHaveLength(1);
  });

  // Merge was the one lifecycle call without a rejected-state guard, and it
  // writes state = 'expired'. Because the tombstone lookup keyed on state
  // alone, that laundered a rejected claim back into the corpus: re-propose
  // the identical statement, verify it, and a statement the member had
  // explicitly rejected as false became eligible for patches and drafts.
  it('cannot launder a rejected claim back into the corpus by merging it', () => {
    const FABRICATED = 'I single-handedly built the entire LinkedIn platform.';
    const rejected = proposeClaim(db, {
      statement: FABRICATED,
      evidence: EVIDENCE(),
      method: 'model_proposed',
    });
    rejectClaim(db, {
      claim_id: rejected.id,
      reason: 'fabricated',
      confirm: true,
      reviewer: 'test',
    });

    const decoy = proposeClaim(db, {
      statement: 'A perfectly ordinary claim used as the merge target.',
      evidence: EVIDENCE(),
      method: 'parser',
    });

    expect(
      codeOf(() =>
        mergeClaim(db, {
          claim_id: rejected.id,
          merge_into: decoy.id,
          confirm: true,
          reviewer: 'test',
        }),
      ),
    ).toBe('TERMINAL_STATE');
    expect(getClaim(db, rejected.id).state).toBe('rejected');
    expect(
      codeOf(() =>
        proposeClaim(db, { statement: FABRICATED, evidence: EVIDENCE(), method: 'manual' }),
      ),
    ).toBe('CLAIM_REJECTED_TOMBSTONE');
  });

  it('refuses to merge a live claim into a rejected tombstone', () => {
    const live = proposeClaim(db, {
      statement: 'A live candidate claim that should stay live.',
      evidence: EVIDENCE(),
      method: 'parser',
    });
    const dead = proposeClaim(db, {
      statement: 'A claim that gets rejected and becomes the target.',
      evidence: EVIDENCE(),
      method: 'parser',
    });
    rejectClaim(db, { claim_id: dead.id, reason: 'not true', confirm: true, reviewer: 'test' });

    expect(
      codeOf(() =>
        mergeClaim(db, { claim_id: live.id, merge_into: dead.id, confirm: true, reviewer: 'test' }),
      ),
    ).toBe('TERMINAL_STATE');
    expect(getClaim(db, live.id).state).toBe('candidate');
  });

  // The sweep expires verified claims past review_by and runs at every process
  // boot. Nothing used to update review_by, so a human re-review could never be
  // persisted: verify -> next boot -> expired -> forever, with every canonical
  // section citing the claim permanently blocked on EVIDENCE_NOT_VERIFIED.
  it('a re-verified stale claim survives the next retention sweep', () => {
    const claim = proposeClaim(db, {
      statement: 'A claim that went stale and was then re-reviewed by a human.',
      evidence: EVIDENCE(),
      method: 'parser',
      review_by: '2020-01-01T00:00:00.000Z',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });
    expect(runRetentionSweep(db).claims_expired).toBe(1);
    expect(getClaim(db, claim.id).state).toBe('expired');

    verifyClaim(db, { claim_id: claim.id, confirm: true });
    expect(getClaim(db, claim.id).state).toBe('verified');

    expect(runRetentionSweep(db).claims_expired).toBe(0);
    expect(getClaim(db, claim.id).state).toBe('verified');
    expect(getClaim(db, claim.id).review_by).toBeNull();
  });

  it('accepts a fresh review_by at verification and keeps expiring on it', () => {
    const claim = proposeClaim(db, {
      statement: 'A claim re-verified with an explicit next review date.',
      evidence: EVIDENCE(),
      method: 'parser',
      review_by: '2020-01-01T00:00:00.000Z',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true, review_by: '2999-01-01T00:00:00.000Z' });
    expect(getClaim(db, claim.id).review_by).toBe('2999-01-01T00:00:00.000Z');
    expect(runRetentionSweep(db).claims_expired).toBe(0);
    expect(getClaim(db, claim.id).state).toBe('verified');
  });

  // Defence in depth: even if some future writer moves a row out of 'rejected',
  // rejected_reason survives and must still block the statement.
  it('blocks re-proposal from the tombstone reason even if the state is rewritten', () => {
    const STATEMENT = 'A statement whose tombstone state gets tampered with.';
    const claim = proposeClaim(db, {
      statement: STATEMENT,
      evidence: EVIDENCE(),
      method: 'parser',
    });
    rejectClaim(db, { claim_id: claim.id, reason: 'wrong', confirm: true, reviewer: 'test' });
    db.run("UPDATE claims SET state = 'expired' WHERE id = ?", claim.id);

    expect(
      codeOf(() =>
        proposeClaim(db, { statement: STATEMENT, evidence: EVIDENCE(), method: 'manual' }),
      ),
    ).toBe('CLAIM_REJECTED_TOMBSTONE');
  });
});
