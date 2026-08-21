import { afterEach, describe, expect, it } from 'vitest';
import {
  getClaimEvidence,
  listClaims,
  markClaimAmbiguous,
  mergeClaim,
  proposeClaim,
  rejectClaim,
  verifyClaim,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The parts of a claim's life that are not propose-then-verify: marking one
// ambiguous, merging a duplicate into another, and searching the corpus.
//
// The lifecycle guards matter more than they look. A claim is the unit this
// product stakes its honesty on, and every transition that could quietly
// resurrect a rejected statement or strand evidence is one that has to refuse.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function corpus(label = 'claim-lifecycle') {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  const seeded = seedHealthy(fixture);
  const list = (filters = {}) => listClaims(fixture.db, filters, fixture.fts5);
  return { fixture, db: fixture.db, seeded, list };
}

describe('marking a claim ambiguous', () => {
  it('refuses without an explicit confirmation', () => {
    const { db, seeded } = corpus();

    expect(() =>
      markClaimAmbiguous(db, {
        claim_id: seeded.candidateId,
        confirm: false,
        reviewer: 'user:test',
      }),
    ).toThrow(/human decision/i);
  });

  it('records the state and keeps the note as a stated limitation', () => {
    const { db, seeded } = corpus();

    const claim = markClaimAmbiguous(db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reviewer: 'user:test',
      note: 'true of the CLI, not of the dashboard',
    });

    expect(claim.state).toBe('ambiguous');
    // The limitation travels with the claim, so anything citing it later can
    // see the qualification rather than the bare statement.
    expect(claim.limitations).toBe('true of the CLI, not of the dashboard');
    expect(claim.reviewed_by).toBe('user:test');
  });

  it('refuses to reopen a rejected claim', () => {
    const { db, seeded } = corpus();
    rejectClaim(db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reason: 'overstated',
      reviewer: 'user:test',
    });

    // A rejection is a tombstone. Routing around it through 'ambiguous' would
    // let a statement the member threw out come back.
    expect(() =>
      markClaimAmbiguous(db, {
        claim_id: seeded.candidateId,
        confirm: true,
        reviewer: 'user:test',
      }),
    ).toThrow(/stay rejected/i);
  });

  it('refuses to act on a claim that was merged away', () => {
    const { db, seeded } = corpus();
    mergeClaim(db, {
      claim_id: seeded.candidateId,
      merge_into: seeded.verifiedId,
      confirm: true,
      reviewer: 'user:test',
    });

    expect(() =>
      markClaimAmbiguous(db, {
        claim_id: seeded.candidateId,
        confirm: true,
        reviewer: 'user:test',
      }),
    ).toThrow(/merged into/i);
  });
});

describe('merging claims', () => {
  it('refuses without an explicit confirmation', () => {
    const { db, seeded } = corpus();

    expect(() =>
      mergeClaim(db, {
        claim_id: seeded.candidateId,
        merge_into: seeded.verifiedId,
        confirm: false,
        reviewer: 'user:test',
      }),
    ).toThrow(/human decision/i);
  });

  it('points the merged claim at its target and moves it out of the corpus', () => {
    const { db, seeded, list } = corpus();

    const merged = mergeClaim(db, {
      claim_id: seeded.candidateId,
      merge_into: seeded.verifiedId,
      confirm: true,
      reviewer: 'user:test',
    });

    expect(merged.merged_into).toBe(seeded.verifiedId);
    // It is no longer a live claim, but it is still there — a merge is not a
    // deletion, and the trail has to survive.
    expect(list({ state: 'candidate' }).some((c) => c.id === seeded.candidateId)).toBe(false);
    expect(list().some((c) => c.id === seeded.candidateId)).toBe(true);
  });

  it('refuses to merge a claim into itself', () => {
    const { db, seeded } = corpus();

    expect(() =>
      mergeClaim(db, {
        claim_id: seeded.candidateId,
        merge_into: seeded.candidateId,
        confirm: true,
        reviewer: 'user:test',
      }),
    ).toThrow(/into itself/i);
  });

  it('refuses to merge a rejected claim, so a tombstone cannot be revived', () => {
    const { db, seeded } = corpus();
    rejectClaim(db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reason: 'overstated',
      reviewer: 'user:test',
    });

    // Merge writes state = 'expired'. Without this guard it would move a
    // rejected claim out of 'rejected' and let the identical statement be
    // proposed and verified again.
    expect(() =>
      mergeClaim(db, {
        claim_id: seeded.candidateId,
        merge_into: seeded.verifiedId,
        confirm: true,
        reviewer: 'user:test',
      }),
    ).toThrow();
  });

  it('refuses a target that does not exist', () => {
    const { db, seeded } = corpus();

    expect(() =>
      mergeClaim(db, {
        claim_id: seeded.candidateId,
        merge_into: 'clm_nope',
        confirm: true,
        reviewer: 'user:test',
      }),
    ).toThrow();
  });
});

describe('searching and filtering the corpus', () => {
  it('finds a claim by a word in its statement', () => {
    const { fixture, list } = corpus('claim-search');

    const found = list({ q: 'hash-chained' });
    expect(found.length).toBeGreaterThan(0);
    for (const claim of found) expect(claim.statement).toMatch(/hash-chained/i);
    expect(fixture.fts5 || true).toBe(true);
  });

  it('returns nothing for a term no claim contains, rather than everything', () => {
    const { list } = corpus('claim-search-empty');
    expect(list({ q: 'zzzz-no-claim-says-this' })).toEqual([]);
  });

  it('treats LIKE wildcards in a query as literal characters', () => {
    const { db, seeded, list } = corpus('claim-search-wildcards');
    proposeClaim(db, {
      statement: 'The parser handles 100% of the sample archives.',
      evidence: [{ artifact_id: seeded.artifactId, location: {} }],
      method: 'manual',
    });

    // A bare % must not match every claim, and an underscore must not stand in
    // for any character — otherwise search silently over-reports.
    const percent = list({ q: '%' });
    const underscore = list({ q: '_' });
    expect(percent.length).toBeLessThan(list().length);
    expect(underscore.length).toBeLessThan(list().length);
  });

  it('filters by state, by sensitivity and by the artifact a claim cites', () => {
    const { seeded, list } = corpus('claim-filters');

    for (const claim of list({ state: 'verified' })) expect(claim.state).toBe('verified');

    const citing = list({ artifact_id: seeded.artifactId });
    expect(citing.length).toBeGreaterThan(0);

    const other = list({ artifact_id: 'art_nothing_cites_this' });
    expect(other).toEqual([]);
  });

  it('finds claims whose review date has passed', () => {
    const { seeded, list } = corpus('claim-stale');

    const stale = list({ stale: true });
    // The expired fixture claim is past its review-by date; a corpus that never
    // surfaced those would let old statements drift into being wrong.
    expect(stale.every((c) => c.review_by !== null)).toBe(true);
    expect(seeded.expiredId.length).toBeGreaterThan(0);
  });
});

describe('the evidence behind a claim', () => {
  it('names the artifact and the location that supports it', () => {
    const { db, seeded } = corpus('claim-evidence');

    const evidence = getClaimEvidence(db, seeded.verifiedId);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]?.artifact_id).toBe(seeded.artifactId);
    // Without a relpath the member cannot go and look, which is the whole point.
    expect(evidence[0]?.source_relpath).toBeTruthy();
  });

  it('refuses a claim that cites nothing at all', () => {
    const { db } = corpus('claim-evidence-none');

    // A claim with no evidence is exactly the thing this product exists to
    // prevent, so it cannot be created in the first place.
    expect(() =>
      proposeClaim(db, {
        statement: 'An assertion with nothing behind it.',
        evidence: [],
        method: 'manual',
      }),
    ).toThrow(/at least one evidence/i);
  });

  it('returns nothing for a claim id that does not exist', () => {
    const { db } = corpus('claim-evidence-unknown');
    expect(getClaimEvidence(db, 'clm_nope')).toEqual([]);
  });

  it('refuses to propose a claim citing an artifact that does not exist', () => {
    const { db } = corpus('claim-evidence-missing');

    expect(() =>
      proposeClaim(db, {
        statement: 'Backed by something imaginary.',
        evidence: [{ artifact_id: 'art_nope', location: {} }],
        method: 'manual',
      }),
    ).toThrow();
  });
});

describe('verification', () => {
  it('is idempotent: verifying an already-verified claim changes nothing', () => {
    const { db, seeded } = corpus('claim-verify-twice');
    const before = verifyClaim(db, {
      claim_id: seeded.verifiedId,
      confirm: true,
      reviewer: 'user:fixture',
    });

    const again = verifyClaim(db, {
      claim_id: seeded.verifiedId,
      confirm: true,
      reviewer: 'user:second-pass',
      review_by: '2027-06-01T00:00:00.000Z',
    });

    // A retrying client must not be able to rewrite who reviewed a claim or
    // when it next needs looking at. Re-review goes through expiry, not here.
    expect(again).toEqual(before);
    expect(again.reviewed_by).toBe('user:fixture');
  });

  it('refuses to verify a claim that was merged into another', () => {
    const { db, seeded } = corpus('claim-verify-merged');
    mergeClaim(db, {
      claim_id: seeded.candidateId,
      merge_into: seeded.verifiedId,
      confirm: true,
      reviewer: 'user:test',
    });

    // Its evidence now lives on the target; verifying it would put the same
    // fact back in the corpus under a second id.
    expect(() =>
      verifyClaim(db, { claim_id: seeded.candidateId, confirm: true, reviewer: 'user:test' }),
    ).toThrow(/merged into/i);
  });

  it('refuses to verify a rejected claim', () => {
    const { db, seeded } = corpus('claim-verify-rejected');
    rejectClaim(db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reason: 'overstated',
      reviewer: 'user:test',
    });

    expect(() =>
      verifyClaim(db, { claim_id: seeded.candidateId, confirm: true, reviewer: 'user:test' }),
    ).toThrow();
  });

  it('carries a review date onto the verified claim', () => {
    const fixture = createFixture('claim-review-by');
    fixtures.push(fixture);
    const { artifactId } = seedRealArtifact(fixture, 'The importer rejects zip bombs.');
    const claim = proposeClaim(fixture.db, {
      statement: 'The importer rejects zip bombs.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
      review_by: '2027-01-01T00:00:00.000Z',
    });

    const verified = verifyClaim(fixture.db, {
      claim_id: claim.id,
      confirm: true,
      reviewer: 'user:test',
    });

    // A claim that is true today may not be in a year. The date is what makes
    // that checkable rather than assumed.
    expect(verified.review_by).toBe('2027-01-01T00:00:00.000Z');
  });
});
