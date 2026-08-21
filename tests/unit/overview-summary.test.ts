import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listApprovals,
  listClaims,
  listConflicts,
  listPublications,
  listSources,
  workbenchSummary,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The Overview becomes the member's model of reality. If a count here disagrees
// with the list it links to, they trust a number that is wrong and stop
// checking — and for "claims expired" or "approvals pending" that is not a
// cosmetic problem.
//
// So every count is asserted equal to the length of the list produced by the
// same predicate the list endpoint uses.

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture('overview');
});

afterEach(() => fixture.close());

describe('workbenchSummary on an empty database', () => {
  it('reports zeroes rather than throwing', () => {
    const summary = workbenchSummary(fixture.db);
    expect(summary.counts.claims).toEqual({
      candidate: 0,
      verified: 0,
      ambiguous: 0,
      expired: 0,
      rejected: 0,
    });
    expect(summary.counts.conflicts_open).toBe(0);
    expect(summary.approvals.pending).toEqual([]);
    expect(summary.approvals.armed).toEqual([]);
    expect(summary.publications_unresolved).toEqual([]);
    // Seeded at boot, so the capability registry is never empty — every
    // external feature exists and is 'unavailable' until a human enables it.
    expect(summary.capabilities.length).toBeGreaterThan(0);
    expect(summary.capabilities.every((c) => c.status === 'unavailable')).toBe(true);
  });
});

describe('workbenchSummary agrees with the lists it summarises', () => {
  beforeEach(() => seedHealthy(fixture));

  it('counts claims exactly as the claim list does, state by state', () => {
    const summary = workbenchSummary(fixture.db);
    for (const state of ['candidate', 'verified', 'ambiguous', 'expired', 'rejected'] as const) {
      expect(`${state}=${summary.counts.claims[state]}`).toBe(
        `${state}=${listClaims(fixture.db, { state }, fixture.fts5).length}`,
      );
    }
  });

  it('counts stale claims exactly as the stale filter does', () => {
    // These are verified claims past their review-by date. The boot sweep
    // demotes them to 'expired', and nothing in the old dashboard surfaced
    // either state.
    const summary = workbenchSummary(fixture.db);
    expect(summary.counts.claims_stale).toBe(
      listClaims(fixture.db, { stale: true }, fixture.fts5).length,
    );
    expect(summary.counts.claims_stale).toBeGreaterThan(0);
  });

  it('counts open conflicts exactly as the conflict list does', () => {
    const summary = workbenchSummary(fixture.db);
    expect(summary.counts.conflicts_open).toBe(listConflicts(fixture.db, { state: 'open' }).length);
    expect(summary.counts.conflicts_open).toBeGreaterThan(0);
  });

  it('counts pending sources exactly as the source list does', () => {
    const summary = workbenchSummary(fixture.db);
    expect(summary.counts.sources_pending).toBe(
      listSources(fixture.db, { status: 'pending_review' }).length,
    );
    expect(summary.counts.sources_pending).toBe(1);
  });

  it('separates pending approvals from armed ones', () => {
    const summary = workbenchSummary(fixture.db);
    expect(summary.approvals.pending.map((a) => a.id)).toEqual(
      listApprovals(fixture.db, 'pending').map((a) => a.id),
    );
    expect(summary.approvals.armed.map((a) => a.id)).toEqual(
      listApprovals(fixture.db, 'granted').map((a) => a.id),
    );
    expect(summary.approvals.pending).toHaveLength(1);
  });

  it('surfaces only publications whose outcome nobody knows', () => {
    const summary = workbenchSummary(fixture.db);
    const unresolved = listPublications(fixture.db).filter(
      (p) => p.outcome === 'ambiguous' || p.outcome === 'pending',
    );
    expect(summary.publications_unresolved.map((p) => p.id)).toEqual(unresolved.map((p) => p.id));
  });

  it('reports the three profile ratios with their explanations intact', () => {
    const summary = workbenchSummary(fixture.db);
    expect(summary.score.map((finding) => finding.dimension)).toEqual([
      'completeness',
      'evidence_coverage',
      'freshness',
    ]);
    for (const finding of summary.score) {
      expect(finding.explanation.length).toBeGreaterThan(0);
      expect(finding.score).toBeGreaterThanOrEqual(0);
      expect(finding.score).toBeLessThanOrEqual(1);
    }
  });

  it('returns the most recent audit events, newest first', () => {
    const summary = workbenchSummary(fixture.db);
    expect(summary.recent_events.length).toBeGreaterThan(0);
    const seqs = summary.recent_events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
  });
});

describe('workbenchSummary is read-only', () => {
  it('writes nothing, because it runs on every visit to the landing screen', () => {
    seedHealthy(fixture);
    const tables = fixture.db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((row) => String(row['name']))
      .sort();
    const snapshot = () =>
      JSON.stringify(tables.map((t) => [t, fixture.db.all(`SELECT * FROM ${t}`)]));

    const before = snapshot();
    workbenchSummary(fixture.db);
    workbenchSummary(fixture.db);
    expect(snapshot()).toBe(before);
  });

  it('does not verify the audit chain, which is the expensive part', () => {
    seedHealthy(fixture);
    const summary = workbenchSummary(fixture.db) as unknown as Record<string, unknown>;
    // Chain status is its own endpoint precisely so the O(n) hash walk stays
    // off the landing screen's critical path. If it reappears here, the
    // Overview starts paying for the whole audit history on every visit.
    expect(summary['chain']).toBeUndefined();
  });
});
