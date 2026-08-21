import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureLane,
  enablePublishing,
  grantApproval,
  readLatestProfileFromDma,
  readChangelogEventsByResource,
  readProfileChangelogState,
  verifyAuditChain,
  verifyLane,
  writeDraft,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Guards that only fire when two records that should agree do not.
//
// Each of these compares something the product wrote against something else the
// product wrote — an anchor against a log, a capability against an account, an
// approval against the revision it names. On a healthy machine they never
// disagree, which is exactly why they are worth proving: the day they do, the
// alternative is publishing on an unproven credential or reporting an edited
// log as intact.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    async put(name, value) {
      values.set(name, value);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    has(name) {
      return values.has(name);
    },
    listNames() {
      return [...values.keys()].sort();
    },
    async remove(name) {
      values.delete(name);
    },
  };
}

beforeEach(() => {
  fixture = createFixture('domain-guards');
  seeded = seedHealthy(fixture);
});

afterEach(() => fixture.close());

describe('the audit anchor against the log', () => {
  it('reports a tail that was rewritten and re-hashed to look consistent', () => {
    expect(verifyAuditChain(fixture.db).valid).toBe(true);
    const anchor = JSON.parse(
      String(
        fixture.db.get("SELECT value_json FROM settings WHERE key = 'audit.head'")?.['value_json'],
      ),
    ) as { seq: number; hash: string };

    // A rewrite that recomputed every hash leaves an internally consistent log.
    // The anchor is the only record of what the head used to be, which is the
    // whole reason it is written in the same transaction as the entry.
    fixture.db.run(
      "UPDATE settings SET value_json = ? WHERE key = 'audit.head'",
      JSON.stringify({ seq: anchor.seq, hash: 'f'.repeat(64) }),
    );

    const status = verifyAuditChain(fixture.db);

    expect(status.valid).toBe(false);
    expect(status.reason).toMatch(/tail was rewritten/i);
    expect(status.broken_at_seq).toBe(anchor.seq);
    expect(status.head_anchored).toBe(true);
  });
});

describe('the publishing capability against the account', () => {
  it('refuses to enable when the account behind a ready capability is not verified', async () => {
    const secrets = memorySecrets();
    await configureLane(fixture.db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await verifyLane(
      fixture.db,
      secrets,
      'write',
      async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );
    // The capability says the probe succeeded and only the member's decision is
    // missing; the account says the credential was never proved. Only one of
    // them can be right, and enabling on the optimistic one would post on a
    // credential nothing checked.
    fixture.db.run("UPDATE linkedin_accounts SET status = 'unverified' WHERE lane = 'write'");

    expect(() => enablePublishing(fixture.db, true, 'dashboard')).toThrow(/not verified/i);
  });
});

describe('an approval against the revision it names', () => {
  it('refuses to grant one whose draft has moved on', () => {
    writeDraft(fixture.db, {
      draft_id: seeded.draftId,
      body_text: 'A materially different body, written after the approval was requested.',
    });
    // Editing invalidates the approval on the spot. Putting the row back to
    // pending is what a writer that moved the draft some other way would leave
    // behind, and the hash comparison catches it without trusting the state.
    fixture.db.run("UPDATE approvals SET state = 'pending' WHERE id = ?", seeded.approvalId);

    expect(() => grantApproval(fixture.db, seeded.approvalId, 'dashboard')).toThrow(
      /draft changed after this approval was requested/i,
    );
  });
});

describe('the changelog state when nothing is being tracked', () => {
  it('answers with the cursor and no events rather than querying for none', () => {
    const state = readProfileChangelogState(fixture.db, []);

    // An empty resource list is not an error; it is a caller that wants the
    // cursor. Building an `IN ()` for it would be a SQL syntax error.
    expect(state.event_count).toBe(0);
    expect(state.newest_captured_at_ms).toBeNull();
    expect(state.newest_processed_at_ms).toBeNull();
  });

  it('answers with zero events for resources it has never seen', () => {
    const state = readProfileChangelogState(fixture.db, ['people', 'people/positions']);

    expect(state.event_count).toBe(0);
    expect(state.newest_captured_at_ms).toBeNull();
  });
});

describe('a live profile read', () => {
  it('refuses a domain that is not part of the profile', async () => {
    // The lane has to be open first, or the capability gate answers before the
    // domain check ever runs — and it is the domain check under test here.
    fixture.db.run(
      `UPDATE capabilities SET status = 'verified', blockers_json = '[]'
        WHERE feature IN ('linkedin.dma_snapshot', 'linkedin.dma_changelog')`,
    );
    const client = {
      assertDomainAllowed: () => {},
      fetchSnapshotDomain: async (domain: string) => ({ domain, rows: [] }),
    };

    // This read covers profile domains only. Accepting a content domain here
    // would quietly widen what the lane pulls, on a call whose whole purpose is
    // to be the narrow one.
    await expect(
      readLatestProfileFromDma(fixture.db, client as never, {
        domains: ['MEMBER_SHARE_INFO'] as never,
      }),
    ).rejects.toThrow(/not a profile snapshot domain/i);
  });
});

describe('a changelog row that will not parse', () => {
  function storeEvent(hash: string, json: string): void {
    fixture.db.run(
      `INSERT INTO dma_changelog_events
       (event_hash, event_json, requested_since_ms, received_at, resource_name, activity_id,
        method, captured_at_ms, processed_at_ms)
       VALUES (?, ?, 0, ?, 'people', ?, 'PARTIAL_UPDATE', 1, 2)`,
      hash,
      json,
      new Date().toISOString(),
      hash,
    );
  }

  it('reads it as carrying no activity rather than crashing the read', () => {
    storeEvent('evt_bad_json', '{not json at all');
    storeEvent('evt_not_object', '"a bare string"');
    storeEvent('evt_array', '[1, 2, 3]');

    const events = readChangelogEventsByResource(fixture.db, ['people']);

    // The raw changelog is append-only history, and LinkedIn's shapes are not
    // ours to control. One row this build cannot read must not take the other
    // twenty-seven with it — it is recorded as having no activity, which the
    // overlay then reports as unresolved rather than guessing at.
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.activity === null)).toBe(true);
    expect(events.every((e) => e.activity_empty === false)).toBe(true);
  });

  it('tells an empty activity apart from an absent one', () => {
    storeEvent('evt_empty', JSON.stringify({ activity: {} }));
    storeEvent('evt_absent', JSON.stringify({ method: 'PARTIAL_UPDATE' }));

    const byHash = new Map(
      readChangelogEventsByResource(fixture.db, ['people']).map((e) => [e.event_hash, e]),
    );

    // "LinkedIn sent an activity with no fields" and "LinkedIn sent no
    // activity" are different facts, and only one of them is worth telling a
    // member about.
    expect(byHash.get('evt_empty')?.activity_empty).toBe(true);
    expect(byHash.get('evt_absent')?.activity_empty).toBe(false);
  });
});
