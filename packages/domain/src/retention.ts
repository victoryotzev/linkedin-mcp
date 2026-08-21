import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { dmaLaneFootprint, type DmaLaneFootprint } from './dmaPurgeService.ts';

export interface SweepReport {
  state_handles_removed: number;
  claims_expired: number;
  observations_expired: number;
  approvals_expired: number;
  swept_at: string;
}

export interface RetentionSummary {
  classes: Array<{ retention_class: string; observations: number }>;
  policy: Record<string, string>;
  /**
   * What the portability lane currently stores. Reported because the policy
   * text below promises the member can delete it, and a promise about data
   * nobody can see the size of is not a useful one.
   */
  dma_lane: DmaLaneFootprint;
}

// What each retention class means, surfaced in the dashboard so the rules are
// visible rather than buried in code.
export function retentionSummary(db: SqliteDriver): RetentionSummary {
  const classes = db
    .all(
      'SELECT retention_class, COUNT(*) AS observations FROM analytics_observations GROUP BY retention_class',
    )
    .map((row) => ({
      retention_class: String(row['retention_class']),
      observations: Number(row['observations']),
    }));
  return {
    classes,
    policy: {
      durable_user:
        "the member's own data, provided by them or exported by them: kept until they delete it",
      durable_dma:
        'own data retrieved through the EU Data Portability lane: kept with consent under the DMA portability terms, and deletable on request with linkedin_purge_run mode=purge_dma (or prune_dma to drop history older than a cutoff)',
      marketing_48h:
        'social-activity data from the Marketing/Community-Management APIs: deleted after 48 hours by the session-start sweep',
      derived: 'computed from other rows; regenerated on demand',
    },
    dma_lane: dmaLaneFootprint(db),
  };
}

// Runs at every process boot (MCP server and dashboard) — session-triggered by
// definition, never on a timer, because this application has no scheduler.
// Expiry is enforced whenever the user actually shows up. That is a product
// decision: LinkedIn's terms restrict how long some classes may be retained,
// which the sweep below enforces, but they do not prohibit scheduled work.
//
// Scope grows with the schema: marketing_48h-class rows (if that lane ever
// exists) and claims past review_by are swept here once their tables land
// (P9 / P3 respectively).
export function runRetentionSweep(db: SqliteDriver, now: Date = new Date()): SweepReport {
  const iso = now.toISOString();
  return withWriteTx(db, () => {
    const handles = db.run(
      'DELETE FROM state_handles WHERE expires_at < ? OR consumed_at IS NOT NULL',
      iso,
    );
    // Freshness: verified claims past their review_by date drop to 'expired'
    // and can no longer back patches or drafts until re-reviewed.
    const claims = db.run(
      `UPDATE claims SET state = 'expired', updated_at = ?
       WHERE state = 'verified' AND review_by IS NOT NULL AND review_by < ?`,
      iso,
      iso,
    );
    // Marketing/CM-sourced social activity may not be stored beyond 48 hours —
    // that limit is a real LinkedIn restricted-use term. Enforcing it on a
    // sweep rather than a timer is this application's choice: it has no
    // scheduler at all. The terms do not prohibit scheduled work, and an
    // earlier version of this comment claimed they did.
    const cutoff = new Date(now.getTime() - 48 * 3600_000).toISOString();
    const observations = db.run(
      "DELETE FROM analytics_observations WHERE retention_class = 'marketing_48h' AND imported_at < ?",
      cutoff,
    );
    // Approval expiry lives here rather than in assertApprovalUsable, which
    // discovers it mid-publish and then throws — rolling its own UPDATE back
    // and leaving the approval reported as 'granted' forever while it occupied
    // its draft's single live-approval slot. A sweep is not inside a failing
    // transaction, so the transition actually sticks.
    const approvals = db.run(
      `UPDATE approvals SET state = 'expired'
       WHERE state IN ('pending', 'granted') AND expires_at < ?`,
      iso,
    );
    return {
      state_handles_removed: Number(handles.changes),
      claims_expired: Number(claims.changes),
      observations_expired: Number(observations.changes),
      approvals_expired: Number(approvals.changes),
      swept_at: iso,
    };
  });
}
