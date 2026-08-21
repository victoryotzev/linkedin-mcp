import type { SqliteDriver } from '@linkedin-mcp/db';
import { listApprovals, type Approval } from './approvalService.ts';
import { queryAuditEvents, type AuditEvent } from './auditService.ts';
import { listCapabilities, type Capability } from './capabilityService.ts';
import { listPublications, type Publication } from './publicationService.ts';
import { scoreProfile, type ScoreFinding } from './profileService.ts';
import { listLanes, type LaneAccount } from './tokenService.ts';

// The read model behind the dashboard's Overview.
//
// It contains no decisions: every number here is a COUNT over the same
// predicate the corresponding list endpoint uses, and a test asserts the two
// agree on shared fixtures. A queue-first home screen becomes the member's
// model of reality, so a count that quietly disagrees with the list it links to
// would be worse than no count at all.
//
// Deliberately absent: verifyAuditChain. It re-hashes every audit row, and this
// runs on every visit to the landing screen. Chain status is its own endpoint,
// loaded independently, so it never delays the actionable content — and its
// semantics stay untouched. Caching or bounding that check would let tampering
// verify as intact, which is not a trade this file is allowed to make.

export interface ClaimStateCounts {
  candidate: number;
  verified: number;
  ambiguous: number;
  expired: number;
  rejected: number;
}

export interface PatchStateCounts {
  proposed: number;
  approved: number;
  applied: number;
  superseded: number;
  rejected: number;
}

export interface WorkbenchCounts {
  claims: ClaimStateCounts;
  /** Verified claims past their review-by date; the boot sweep will expire them. */
  claims_stale: number;
  conflicts_open: number;
  sources_pending: number;
  artifacts: number;
  patches: PatchStateCounts;
  /** Applied by hand but not yet seen in a snapshot — the copy/paste loop is still open. */
  patches_applied_unverified: number;
  drafts_failing_validation: number;
  drafts_unvalidated: number;
  drafts_validated: number;
}

export interface WorkbenchSummary {
  counts: WorkbenchCounts;
  approvals: {
    pending: Approval[];
    /**
     * Granted but not yet consumed. A live, single-use authorisation to publish
     * exactly one revision — the old dashboard showed these as a one-line
     * history row, which is the wrong weight entirely.
     */
    armed: Approval[];
  };
  /** Ambiguous or still pending: nobody knows whether the post went out. */
  publications_unresolved: Publication[];
  capabilities: Capability[];
  lanes: LaneAccount[];
  score: ScoreFinding[];
  recent_events: AuditEvent[];
  generated_at: string;
}

function countBy(db: SqliteDriver, sql: string, ...params: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db.all(sql, ...params)) {
    out[String(row['k'])] = Number(row['n']);
  }
  return out;
}

function scalar(db: SqliteDriver, sql: string, ...params: string[]): number {
  return Number(db.get(sql, ...params)?.['n'] ?? 0);
}

export function workbenchSummary(db: SqliteDriver): WorkbenchSummary {
  const now = new Date().toISOString();

  const claims = countBy(db, 'SELECT state AS k, COUNT(*) AS n FROM claims GROUP BY state');
  const patches = countBy(db, 'SELECT state AS k, COUNT(*) AS n FROM field_patches GROUP BY state');

  // The latest report for each draft, and whether it describes the revision the
  // draft is on now. A report about superseded text says nothing about the
  // draft's current state, so it counts as unvalidated rather than as a pass.
  const latestReport = `
    SELECT v.draft_id, v.passed, v.revision_hash
    FROM validation_reports v
    WHERE v.rowid = (SELECT MAX(v2.rowid) FROM validation_reports v2 WHERE v2.draft_id = v.draft_id)
  `;

  return {
    counts: {
      claims: {
        candidate: claims['candidate'] ?? 0,
        verified: claims['verified'] ?? 0,
        ambiguous: claims['ambiguous'] ?? 0,
        expired: claims['expired'] ?? 0,
        rejected: claims['rejected'] ?? 0,
      },
      claims_stale: scalar(
        db,
        `SELECT COUNT(*) AS n FROM claims
         WHERE state = 'verified' AND review_by IS NOT NULL AND review_by < ?`,
        now,
      ),
      conflicts_open: scalar(db, "SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'"),
      sources_pending: scalar(
        db,
        "SELECT COUNT(*) AS n FROM sources WHERE status = 'pending_review'",
      ),
      artifacts: scalar(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE superseded_by IS NULL'),
      patches: {
        proposed: patches['proposed'] ?? 0,
        approved: patches['approved'] ?? 0,
        applied: patches['applied'] ?? 0,
        superseded: patches['superseded'] ?? 0,
        rejected: patches['rejected'] ?? 0,
      },
      patches_applied_unverified: scalar(
        db,
        `SELECT COUNT(*) AS n FROM field_patches
         WHERE state = 'applied' AND applied_verified_snapshot_id IS NULL`,
      ),
      drafts_failing_validation: scalar(
        db,
        `SELECT COUNT(*) AS n FROM post_drafts d
         JOIN (${latestReport}) r ON r.draft_id = d.id
         WHERE d.state NOT IN ('published', 'abandoned')
           AND r.revision_hash = d.current_revision_hash
           AND r.passed = 0`,
      ),
      drafts_unvalidated: scalar(
        db,
        `SELECT COUNT(*) AS n FROM post_drafts d
         WHERE d.state NOT IN ('published', 'abandoned')
           AND NOT EXISTS (
             SELECT 1 FROM (${latestReport}) r
             WHERE r.draft_id = d.id AND r.revision_hash = d.current_revision_hash
           )`,
      ),
      drafts_validated: scalar(
        db,
        "SELECT COUNT(*) AS n FROM post_drafts WHERE state = 'validated'",
      ),
    },
    approvals: {
      pending: listApprovals(db, 'pending'),
      armed: listApprovals(db, 'granted'),
    },
    publications_unresolved: listPublications(db).filter(
      (publication) => publication.outcome === 'ambiguous' || publication.outcome === 'pending',
    ),
    capabilities: listCapabilities(db),
    lanes: listLanes(db),
    score: scoreProfile(db),
    recent_events: queryAuditEvents(db, { limit: 10 }),
    generated_at: now,
  };
}
