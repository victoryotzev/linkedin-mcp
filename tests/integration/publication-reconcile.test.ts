import { afterEach, describe, expect, it } from 'vitest';
import {
  executePublication,
  grantApproval,
  listPublications,
  reconcilePublication,
} from '@linkedin-mcp/domain';
import { DryRunPublisher, type Publisher } from '@linkedin-mcp/linkedin';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Reconciliation: the way out of a publication whose outcome nobody knows.
//
// A row is written as 'pending' before the network call and only moves
// afterwards, so a crash between the two strands it: the approval is already
// consumed, the idempotency key blocks a retry, and nothing else can resolve
// it. The only authority left is the member going to LinkedIn and looking, so
// this is a human attestation and is gated as one.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

class LostResponsePublisher implements Publisher {
  readonly name = 'dry_run' as const;
  async publish(): Promise<never> {
    throw new Error('socket closed before a response arrived');
  }
}

async function ambiguous(label: string) {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  const seeded = seedHealthy(fixture);
  grantApproval(fixture.db, seeded.approvalId, 'dashboard');
  const publication = await executePublication(fixture.db, new LostResponsePublisher(), {
    approval_id: seeded.approvalId,
  });
  return { fixture, db: fixture.db, seeded, publication };
}

describe('a publication whose response was lost', () => {
  it('is recorded as ambiguous rather than as a failure', async () => {
    const { publication } = await ambiguous('reconcile-ambiguous');

    // Calling it failed would be a claim nobody can make: the post may well be
    // live. Ambiguous is the only honest word for it.
    expect(publication.outcome).toBe('ambiguous');
    expect(publication.linkedin_post_urn).toBeNull();
  });

  it('consumes the approval anyway, so nothing can be sent twice', async () => {
    const { db, seeded } = await ambiguous('reconcile-consumed');

    const state = db.get('SELECT state FROM approvals WHERE id = ?', seeded.approvalId)?.['state'];
    expect(state).not.toBe('granted');
  });
});

describe('reconciling by attestation', () => {
  it('refuses without an explicit confirmation', async () => {
    const { db, publication } = await ambiguous('reconcile-unconfirmed');

    expect(() =>
      reconcilePublication(db, {
        publication_id: publication.id,
        method: 'manual_attestation',
        found: true,
        confirm: false,
        actor: 'dashboard',
      }),
    ).toThrow(/human attestation/i);
  });

  it('records that the post was found, with the URL the member saw', async () => {
    const { db, publication } = await ambiguous('reconcile-found');

    const resolved = reconcilePublication(db, {
      publication_id: publication.id,
      method: 'manual_attestation',
      found: true,
      confirm: true,
      actor: 'dashboard',
      post_url: 'https://www.linkedin.com/feed/update/urn:li:share:7000',
    });

    expect(resolved.outcome).toBe('reconciled_success');
    expect(resolved.linkedin_post_urn).toContain('linkedin.com');
    // The draft is published now, which is what stops it being offered again.
    expect(
      db.get('SELECT state FROM post_drafts WHERE id = ?', publication.draft_id)?.['state'],
    ).toBe('published');
  });

  it('records that the post was not there, leaving the draft unpublished', async () => {
    const { db, publication } = await ambiguous('reconcile-not-found');

    const resolved = reconcilePublication(db, {
      publication_id: publication.id,
      method: 'manual_attestation',
      found: false,
      confirm: true,
      actor: 'dashboard',
    });

    expect(resolved.outcome).toBe('reconciled_failed');
    expect(
      db.get('SELECT state FROM post_drafts WHERE id = ?', publication.draft_id)?.['state'],
    ).not.toBe('published');
  });

  it('refuses a post URL that is not a LinkedIn URL', async () => {
    const { db, publication } = await ambiguous('reconcile-bad-url');

    // The URL is stored as the record of where the post is. Accepting an
    // arbitrary one would put an unrelated link into the member's audit trail.
    for (const url of [
      'https://example.com/post/1',
      'http://www.linkedin.com/feed/update/1',
      'https://linkedin.com.evil.test/feed',
      'javascript:alert(1)',
    ]) {
      expect(
        () =>
          reconcilePublication(db, {
            publication_id: publication.id,
            method: 'manual_attestation',
            found: true,
            confirm: true,
            actor: 'dashboard',
            post_url: url,
          }),
        `${url} should be refused`,
      ).toThrow(/linkedin\.com/i);
    }
  });

  it('accepts both the www and bare linkedin.com forms over https', async () => {
    const { db, publication } = await ambiguous('reconcile-url-forms');

    const resolved = reconcilePublication(db, {
      publication_id: publication.id,
      method: 'manual_attestation',
      found: true,
      confirm: true,
      actor: 'dashboard',
      post_url: 'https://linkedin.com/feed/update/urn:li:share:7001',
    });
    expect(resolved.outcome).toBe('reconciled_success');
  });

  it('refuses to reconcile a publication that already has a settled outcome', async () => {
    const fixture = createFixture('reconcile-settled');
    fixtures.push(fixture);
    const seeded = seedHealthy(fixture);
    grantApproval(fixture.db, seeded.approvalId, 'dashboard');
    const publication = await executePublication(fixture.db, new DryRunPublisher(), {
      approval_id: seeded.approvalId,
    });

    // Only ambiguous and pending need resolving. Reconciling a settled one
    // would let an attestation overwrite an observed fact.
    expect(() =>
      reconcilePublication(fixture.db, {
        publication_id: publication.id,
        method: 'manual_attestation',
        found: false,
        confirm: true,
        actor: 'dashboard',
      }),
    ).toThrow(/only ambiguous or pending/i);
  });

  it('refuses a publication id that does not exist', async () => {
    const { db } = await ambiguous('reconcile-missing');

    expect(() =>
      reconcilePublication(db, {
        publication_id: 'pub_nope',
        method: 'manual_attestation',
        found: true,
        confirm: true,
        actor: 'dashboard',
      }),
    ).toThrow(/not found/i);
  });

  it('cannot be reconciled a second time', async () => {
    const { db, publication } = await ambiguous('reconcile-twice');
    reconcilePublication(db, {
      publication_id: publication.id,
      method: 'manual_attestation',
      found: true,
      confirm: true,
      actor: 'dashboard',
    });

    expect(() =>
      reconcilePublication(db, {
        publication_id: publication.id,
        method: 'manual_attestation',
        found: false,
        confirm: true,
        actor: 'dashboard',
      }),
    ).toThrow();
  });
});

describe('listing publications', () => {
  it('lists them all, and filters by outcome', async () => {
    const { db } = await ambiguous('reconcile-list');

    expect(listPublications(db).length).toBeGreaterThan(0);
    expect(listPublications(db, 'ambiguous').every((p) => p.outcome === 'ambiguous')).toBe(true);
    expect(listPublications(db, 'reconciled_success')).toEqual([]);
  });
});

describe('replaying an approval', () => {
  it('returns the existing publication rather than sending a second post', async () => {
    const fixture = createFixture('reconcile-replay');
    fixtures.push(fixture);
    const seeded = seedHealthy(fixture);
    grantApproval(fixture.db, seeded.approvalId, 'dashboard');

    const first = await executePublication(fixture.db, new DryRunPublisher(), {
      approval_id: seeded.approvalId,
    });
    const second = await executePublication(fixture.db, new DryRunPublisher(), {
      approval_id: seeded.approvalId,
    });

    // The idempotency key is derived from the approval, so a replay after a
    // timeout or a retry cannot put a second copy on the member's profile.
    expect(second.id).toBe(first.id);
    expect(listPublications(fixture.db).length).toBe(1);
  });
});
