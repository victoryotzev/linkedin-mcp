import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  DEFAULT_SNAPSHOT_DOMAINS,
  configureLane,
  laneAccount,
  latestDmaObservation,
  latestSnapshot,
  listCapabilities,
  listPublishedPosts,
  seedCapabilities,
  syncChangelogFromDma,
  syncFromDma,
  verifyAuditChain,
  verifyLane,
  type DmaSource,
  type SecretStorePort,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';

let dir: string;
let db: SqliteDriver;

// An in-memory stand-in for the DPAPI store: these tests are about the sync
// mapping and the lane state machine, not about Windows crypto (which has its
// own suite).
function memoryStore(): SecretStorePort {
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
    async remove(name) {
      values.delete(name);
    },
  };
}

const SNAPSHOT: Record<string, Array<Record<string, unknown>>> = {
  PROFILE: [
    {
      'First Name': 'Alex',
      'Last Name': 'Rivera',
      Headline: 'Full-Stack Web Developer',
      Summary: 'Builds local-first systems.',
      Industry: 'Software Development',
      'Geo Location': 'Ghent, Belgium',
      Websites: 'https://alex-rivera.example',
    },
  ],
  POSITIONS: [
    {
      'Company Name': 'Vale Wind Power',
      Title: 'Web Developer',
      'Started On': 'Jun 2020',
      'Finished On': '',
      Description: 'ERP platform',
    },
  ],
  EDUCATION: [
    { 'School Name': 'Northgate State University', 'Degree Name': 'BSc', 'Start Date': '2023' },
  ],
  SKILLS: [{ Name: 'TypeScript' }, { Name: 'Python' }],
  MEMBER_SHARE_INFO: [
    {
      Date: '2026-03-01 10:00:00',
      ShareCommentary: 'A post about renovating deployed software rather than rewriting it.',
      ShareLink: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
      Visibility: 'MEMBER_NETWORK',
    },
    {
      Date: '2026-04-01 10:00:00',
      ShareCommentary: 'Втори пост на български за енергийна ефективност.',
      Visibility: 'MEMBER_NETWORK',
    },
  ],
};

// Changelog fixtures shaped like real Member Changelog elements. The
// timestamps sit just under the test clock (2026-08-12T10:00:00Z) so the
// future-skew clamp accepts them.
const OLDER_CAPTURED_AT = 1_786_527_000_000;
const OLDER_PROCESSED_AT = 1_786_527_100_000;
const NEWEST_CAPTURED_AT = 1_786_528_000_000;
const NEWEST_PROCESSED_AT = 1_786_528_100_000;

const OLDER_EVENT: Record<string, unknown> = {
  id: 101,
  activityId: 'act-1',
  owner: 'urn:li:person:abc',
  actor: 'urn:li:person:abc',
  resourceName: 'people',
  resourceId: 'urn:li:person:abc',
  method: 'PARTIAL_UPDATE',
  configVersion: 3,
  activityStatus: 'SUCCESS',
  capturedAt: OLDER_CAPTURED_AT,
  processedAt: OLDER_PROCESSED_AT,
  activity: { headline: { localized: { en_US: 'Full-Stack Web Developer' } } },
};

const NEWEST_EVENT: Record<string, unknown> = {
  id: 102,
  activityId: 'act-2',
  owner: 'urn:li:person:abc',
  actor: 'urn:li:person:abc',
  resourceName: 'people/positions',
  resourceId: 'pos-1',
  method: 'CREATE',
  configVersion: 3,
  activityStatus: 'SUCCESS',
  capturedAt: NEWEST_CAPTURED_AT,
  processedAt: NEWEST_PROCESSED_AT,
  activity: { title: 'Web Developer', companyName: 'Vale Wind Power' },
};

function fakeDma(calls: string[] = []): DmaSource & { calls: string[] } {
  return {
    calls,
    assertDomainAllowed(domain: string) {
      if (domain === 'INBOX') throw new DomainError('INVALID_INPUT', 'blocked domain');
    },
    async fetchSnapshotDomain(domain: string) {
      calls.push(domain);
      return { domain, rows: SNAPSHOT[domain] ?? [] };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-dma-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  seedCapabilities(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function openReadLane(): Promise<SecretStorePort> {
  const store = memoryStore();
  await configureLane(db, store, {
    lane: 'read',
    client_id: 'test-client-id-read',
    access_token: 'a-token-long-enough-to-pass-validation',
    expires_in_seconds: 3600,
  });
  await verifyLane(db, store, 'read', async () => ({ ok: true }));
  return store;
}

describe('lane configuration', () => {
  it('refuses an implausible token and stores nothing', async () => {
    const store = memoryStore();
    await expect(
      configureLane(db, store, { lane: 'read', client_id: 'x', access_token: 'short' }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(store.has('linkedin.access_token.read')).toBe(false);
  });

  it('configured is not verified: the capability only opens after a live probe', async () => {
    const store = memoryStore();
    await configureLane(db, store, {
      lane: 'read',
      client_id: 'c',
      access_token: 'a-token-long-enough-to-pass-validation',
    });
    const beforeVerify = db.get(
      "SELECT status FROM capabilities WHERE feature = 'linkedin.dma_snapshot'",
    );
    expect(String(beforeVerify?.['status'])).toBe('configured');

    await verifyLane(db, store, 'read', async () => ({ ok: true }));
    const afterVerify = db.get(
      "SELECT status, api_version FROM capabilities WHERE feature = 'linkedin.dma_snapshot'",
    );
    expect(String(afterVerify?.['status'])).toBe('verified');
    // The DMA endpoints are version-pinned; the pin is recorded, not assumed.
    expect(String(afterVerify?.['api_version'])).toBe('202312');
  });

  it('a 401 demotes the lane to expired with an actionable blocker', async () => {
    const store = memoryStore();
    await configureLane(db, store, {
      lane: 'read',
      client_id: 'c',
      access_token: 'a-token-long-enough-to-pass-validation',
    });
    await expect(
      verifyLane(db, store, 'read', async () => ({ ok: false, status: 401, message: 'expired' })),
    ).rejects.toBeInstanceOf(DomainError);
    const row = db.get(
      "SELECT status, blockers_json FROM capabilities WHERE feature = 'linkedin.dma_snapshot'",
    );
    expect(String(row?.['status'])).toBe('expired');
    expect(String(row?.['blockers_json'])).toContain('token_expired');
  });

  it('a working token that returns no data proves the credential but does not open the lane', async () => {
    const store = memoryStore();
    await configureLane(db, store, {
      lane: 'read',
      client_id: 'c',
      access_token: 'a-token-long-enough-to-pass-validation',
    });
    const result = await verifyLane(db, store, 'read', async () => ({
      ok: true,
      warnings: ['snapshot_not_ready'],
    }));

    expect(result.warnings).toEqual(['snapshot_not_ready']);
    // The account is verified — LinkedIn answered the probe.
    expect(laneAccount(db, 'read').status).toBe('verified');
    // The capability is not, so a sync cannot run and import nothing at all
    // while presenting that as the member's whole history.
    const cap = listCapabilities(db, 'linkedin.dma_snapshot')[0]!;
    expect(cap.status).toBe('configured');
    expect(cap.blockers).toEqual(['snapshot_not_ready']);
    expect(cap.remediation).toContain('The token works');
    await expect(syncFromDma(db, fakeDma())).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });

  // Demotion is what requireCapability reads, so demoting on a dropped
  // connection or a 429 closed a working lane until a human re-verified it.
  it('a transient probe failure leaves a verified lane untouched', async () => {
    const store = await openReadLane();
    expect(listCapabilities(db, 'linkedin.dma_snapshot')[0]!.status).toBe('verified');

    await expect(
      verifyLane(db, store, 'read', async () => ({
        ok: false,
        status: 0,
        message: 'socket hang up',
        retryable: true,
      })),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });

    expect(listCapabilities(db, 'linkedin.dma_snapshot')[0]!.status).toBe('verified');
  });

  it('a 401 still demotes, so a genuinely dead credential is not masked', async () => {
    const store = await openReadLane();
    await expect(
      verifyLane(db, store, 'read', async () => ({ ok: false, status: 401, message: 'expired' })),
    ).rejects.toBeInstanceOf(DomainError);
    expect(listCapabilities(db, 'linkedin.dma_snapshot')[0]!.status).toBe('expired');
  });

  it('one failing domain does not discard the domains that succeeded', async () => {
    await openReadLane();
    const calls: string[] = [];
    const flaky: DmaSource = {
      assertDomainAllowed() {},
      async fetchSnapshotDomain(domain: string) {
        calls.push(domain);
        if (domain === 'SKILLS') throw new DomainError('INTERNAL', 'LinkedIn 503 on SKILLS');
        return { domain, rows: SNAPSHOT[domain] ?? [] };
      },
    };

    const report = await syncFromDma(db, flaky);
    // Every domain was still attempted.
    expect(calls).toContain('MEMBER_SHARE_INFO');
    const skills = report.domains.find((d) => d.domain === 'SKILLS')!;
    expect(skills.note).toContain('failed:');
    expect(skills.imported).toBe(0);

    // And the profile that DID come back was persisted.
    const snapshot = latestSnapshot(db)!;
    expect(snapshot.fields['headline']?.value_text).toBe('Full-Stack Web Developer');
    expect(snapshot.fields['skills']).toBeUndefined();
    expect(listPublishedPosts(db)).toHaveLength(2);

    // The audit event names what failed rather than implying a clean sync.
    const event = db.get("SELECT payload_json FROM audit_events WHERE event_type = 'dma.sync'")!;
    expect(String(event['payload_json'])).toContain('SKILLS');
  });

  it('never returns the token through any read path', async () => {
    const store = await openReadLane();
    const account = db.get("SELECT * FROM linkedin_accounts WHERE lane = 'read'");
    expect(JSON.stringify(account)).not.toContain('a-token-long-enough-to-pass-validation');
    const audit = db.all('SELECT payload_json FROM audit_events');
    expect(JSON.stringify(audit)).not.toContain('a-token-long-enough-to-pass-validation');
    expect(await store.get('linkedin.access_token.read')).toBe(
      'a-token-long-enough-to-pass-validation',
    );
  });
});

describe('DMA sync', () => {
  // This test used to assert that the stored watermark equalled local
  // now.getTime(), and that the next request's startTime was five minutes
  // before it. That encoded the defect: LinkedIn's cursor is the latest
  // returned processedAt, and a local clock permanently skips every event
  // processed after a request started. The replacement asserts the same
  // replay-safety property plus the correct cursor.
  it('advances the changelog cursor to the newest processedAt, not to local time', async () => {
    await openReadLane();
    const firstNow = new Date('2026-08-12T10:00:00.000Z');
    const starts: number[] = [];
    const client = {
      async fetchChangelog(sinceMs: number) {
        starts.push(sinceMs);
        return [OLDER_EVENT, NEWEST_EVENT];
      },
    };

    const first = await syncChangelogFromDma(db, client, { now: firstNow });
    expect(first.imported).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(db.all('SELECT * FROM dma_changelog_events')).toHaveLength(2);
    expect(first.cursor_ms).toBe(NEWEST_PROCESSED_AT);
    expect(first.cursor_ms).not.toBe(firstNow.getTime());
    expect(first.cursor_advanced).toBe(true);
    const stored = db.get(
      "SELECT processed_at_cursor_ms, watermark_ms FROM dma_changelog_watermarks WHERE lane = 'member'",
    );
    expect(Number(stored?.['processed_at_cursor_ms'])).toBe(NEWEST_PROCESSED_AT);
    // The old column survives as diagnostics; nothing reads it to fetch.
    expect(Number(stored?.['watermark_ms'])).toBe(firstNow.getTime());

    // The newest event is replayed inclusively and deduplicated by payload hash.
    const secondNow = new Date('2026-08-12T10:10:00.000Z');
    const second = await syncChangelogFromDma(db, client, { now: secondNow });
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(starts[1]).toBeLessThanOrEqual(NEWEST_PROCESSED_AT);
    expect(starts[1]).toBe(NEWEST_PROCESSED_AT - 5 * 60 * 1000);
    expect(second.cursor_ms).toBe(NEWEST_PROCESSED_AT);
    expect(second.cursor_advanced).toBe(false);
    expect(db.all('SELECT * FROM dma_changelog_events')).toHaveLength(2);
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it('normalizes changelog metadata beside the untouched raw payload', async () => {
    await openReadLane();
    await syncChangelogFromDma(
      db,
      {
        async fetchChangelog() {
          return [NEWEST_EVENT];
        },
      },
      { now: new Date('2026-08-12T10:00:00.000Z') },
    );
    const row = db.get('SELECT * FROM dma_changelog_events')!;
    expect(row['resource_name']).toBe('people/positions');
    expect(row['method']).toBe('CREATE');
    expect(row['activity_id']).toBe('act-2');
    expect(row['resource_id']).toBe('pos-1');
    expect(Number(row['processed_at_ms'])).toBe(NEWEST_PROCESSED_AT);
    expect(Number(row['captured_at_ms'])).toBe(NEWEST_CAPTURED_AT);
    expect(row['activity_status']).toBe('SUCCESS');
    // Raw stays exactly what LinkedIn sent.
    expect(JSON.parse(String(row['event_json']))).toMatchObject({ resourceId: 'pos-1' });
  });

  it('keeps the cursor when a response carries no events', async () => {
    await openReadLane();
    const now = new Date('2026-08-12T10:00:00.000Z');
    await syncChangelogFromDma(
      db,
      {
        async fetchChangelog() {
          return [NEWEST_EVENT];
        },
      },
      { now },
    );

    const starts: number[] = [];
    const empty = await syncChangelogFromDma(
      db,
      {
        async fetchChangelog(sinceMs: number) {
          starts.push(sinceMs);
          return [];
        },
      },
      { now: new Date('2026-08-12T11:00:00.000Z') },
    );
    expect(empty.rows_fetched).toBe(0);
    expect(empty.cursor_ms).toBe(NEWEST_PROCESSED_AT);
    expect(empty.cursor_advanced).toBe(false);
    expect(
      Number(
        db.get(
          "SELECT processed_at_cursor_ms FROM dma_changelog_watermarks WHERE lane = 'member'",
        )?.['processed_at_cursor_ms'],
      ),
    ).toBe(NEWEST_PROCESSED_AT);
  });

  it('cannot be pushed forward by a missing, malformed or far-future processedAt', async () => {
    await openReadLane();
    const now = new Date('2026-08-12T10:00:00.000Z');
    await syncChangelogFromDma(
      db,
      {
        async fetchChangelog() {
          return [OLDER_EVENT];
        },
      },
      { now },
    );
    const baseline = Number(
      db.get("SELECT processed_at_cursor_ms FROM dma_changelog_watermarks WHERE lane = 'member'")?.[
        'processed_at_cursor_ms'
      ],
    );
    expect(baseline).toBe(OLDER_PROCESSED_AT);

    const report = await syncChangelogFromDma(
      db,
      {
        async fetchChangelog() {
          return [
            { ...NEWEST_EVENT, activityId: 'no-stamp', processedAt: undefined },
            { ...NEWEST_EVENT, activityId: 'string-stamp', processedAt: '1786528100000' },
            // A single corrupt far-future value would otherwise advance the
            // cursor past the whole 28-day window and lose everything in it.
            { ...NEWEST_EVENT, activityId: 'year-3000', processedAt: 32503680000000 },
          ];
        },
      },
      { now: new Date('2026-08-12T11:00:00.000Z') },
    );
    expect(report.rows_fetched).toBe(3);
    expect(report.imported).toBe(3);
    expect(report.events_without_processed_at).toBe(3);
    expect(report.cursor_ms).toBe(OLDER_PROCESSED_AT);
    expect(report.cursor_advanced).toBe(false);
    // The rows are still stored; only the cursor refuses to move.
    expect(db.all('SELECT * FROM dma_changelog_events')).toHaveLength(4);
    expect(db.all('SELECT * FROM dma_changelog_events WHERE processed_at_ms IS NULL')).toHaveLength(
      3,
    );
  });

  it('re-reads the whole retained window once after migration 017 repaired the cursor', async () => {
    await openReadLane();
    const now = new Date('2026-08-12T10:00:00.000Z');
    // The state migration 017 leaves behind: a cursor seeded from stored events
    // and a flag saying it has not been proved by a live fetch yet. The seed is
    // deliberately distrusted for coverage — a seed that landed too high would
    // skip events LinkedIn will never serve again.
    db.run(
      `INSERT INTO dma_changelog_watermarks
       (lane, watermark_ms, last_window_start_ms, last_synced_at, last_rows_fetched,
        last_rows_imported, processed_at_cursor_ms, cursor_repaired)
       VALUES ('member', ?, ?, ?, 0, 0, ?, 1)`,
      now.getTime(),
      0,
      '2026-08-12T09:00:00.000Z',
      NEWEST_PROCESSED_AT,
    );

    const starts: number[] = [];
    const client = {
      async fetchChangelog(sinceMs: number) {
        starts.push(sinceMs);
        return [OLDER_EVENT, NEWEST_EVENT];
      },
    };

    const first = await syncChangelogFromDma(db, client, { now });
    // Full 28-day window, not cursor - 5 minutes.
    expect(starts[0]).toBe(now.getTime() - 28 * 24 * 60 * 60 * 1000);
    expect(first.imported).toBe(2);
    expect(
      Number(
        db.get("SELECT cursor_repaired FROM dma_changelog_watermarks WHERE lane = 'member'")?.[
          'cursor_repaired'
        ],
      ),
    ).toBe(0);

    // Once proved, the normal cursor protocol resumes.
    await syncChangelogFromDma(db, client, { now: new Date('2026-08-12T11:00:00.000Z') });
    expect(starts[1]).toBe(NEWEST_PROCESSED_AT - 5 * 60 * 1000);
  });

  it('does not advance the changelog watermark when the fetch fails', async () => {
    await openReadLane();
    await expect(
      syncChangelogFromDma(db, {
        async fetchChangelog() {
          throw new DomainError('INTERNAL', 'upstream failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(db.get('SELECT * FROM dma_changelog_watermarks')).toBeUndefined();
    expect(db.all('SELECT * FROM dma_changelog_events')).toHaveLength(0);
  });

  it('is refused until the capability is verified', async () => {
    await expect(syncFromDma(db, fakeDma())).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });

  it('maps snapshot domains into a versioned snapshot and imports post history', async () => {
    await openReadLane();
    const client = fakeDma();
    const report = await syncFromDma(db, client);

    // Was pinned to the five domains the old default fetched. The default is
    // now every profile domain plus post history, and it lives in one exported
    // constant so this assertion cannot drift from the implementation.
    expect(client.calls).toEqual([...DEFAULT_SNAPSHOT_DOMAINS]);
    expect(report.snapshot_id).not.toBeNull();
    expect(report.posts_imported).toBe(2);

    const snapshot = latestSnapshot(db)!;
    expect(snapshot.source_kind).toBe('dma_snapshot');
    // LinkedIn gives no data-generation time, so this column must not claim one.
    expect(snapshot.taken_at).toBeNull();
    expect(snapshot.fields['headline']?.value_text).toBe('Full-Stack Web Developer');
    expect(snapshot.fields['experience']?.value_text).toContain('Vale Wind Power');
    expect(snapshot.fields['skills']?.value_text).toBe('TypeScript, Python');

    // A domain the fixture does not answer is its own state, not an empty
    // section and not a failure.
    const courses = report.domains.find((d) => d.domain === 'COURSES')!;
    expect(courses.status).toBe('empty_or_not_ready');
    expect(courses.note).toContain('not proof');
    expect(snapshot.fields['courses']).toBeUndefined();
    expect(report.freshness.guarantee).toBe('not_guaranteed');
    expect(report.freshness.domains.empty_or_not_ready).toContain('COURSES');

    const observation = latestDmaObservation(db)!;
    expect(observation.snapshot_id).toBe(report.snapshot_id);
    expect(observation.content_fingerprint).toBe(report.observation.content_fingerprint);
    expect(observation.freshness_status).toBe(report.freshness.status);

    const posts = listPublishedPosts(db);
    expect(posts).toHaveLength(2);
    // Own data pulled through the portability lane is durable, unlike anything
    // that would come from the Marketing APIs.
    const classes = db
      .all('SELECT DISTINCT retention_class FROM published_posts')
      .map((r) => r['retention_class']);
    expect(classes).toEqual(['durable_dma']);
    expect(posts.some((p) => p.language_guess === 'bg')).toBe(true);
  });

  it('is idempotent: a second sync adds no duplicate posts', async () => {
    await openReadLane();
    await syncFromDma(db, fakeDma());
    const second = await syncFromDma(db, fakeDma());
    expect(second.posts_imported).toBe(0);
    expect(listPublishedPosts(db)).toHaveLength(2);
  });

  it('refuses a blocked domain and records the sync in the audit chain', async () => {
    await openReadLane();
    await expect(syncFromDma(db, fakeDma(), { domains: ['INBOX'] })).rejects.toBeInstanceOf(
      DomainError,
    );

    await syncFromDma(db, fakeDma());
    const events = db.all("SELECT payload_json FROM audit_events WHERE event_type = 'dma.sync'");
    expect(events).toHaveLength(1);
    expect(String(events[0]?.['payload_json'])).toContain('session_triggered');
    expect(verifyAuditChain(db).valid).toBe(true);
  });
});
