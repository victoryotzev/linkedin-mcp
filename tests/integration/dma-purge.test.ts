import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  dmaLaneFootprint,
  latestSnapshot,
  purgeDmaLane,
  readLatestProfileFromDma,
  retentionSummary,
  seedCanonicalSections,
  seedCapabilities,
  syncFromDma,
  updateSection,
  verifyAuditChain,
  type DmaChangelogSource,
  type DmaSource,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';

// The portability terms permit storing Member Portability Data with consent and
// require deleting all of it on request. These tests pin that the deletion is
// real, that it takes nothing with it that is not Portability Data, and that
// what remains afterwards is still internally consistent.

const T10 = new Date('2026-08-12T10:00:00.000Z');
const T11 = new Date('2026-08-12T11:00:00.000Z');
const T12 = new Date('2026-08-12T12:00:00.000Z');
const EVENT_MS = T10.getTime() + 20 * 60 * 1000;

const ROWS: Record<string, Array<Record<string, unknown>>> = {
  PROFILE: [{ Headline: 'Full-Stack Web Developer', 'First Name': 'Alex' }],
  POSITIONS: [{ 'Company Name': 'WES', Title: 'Web Developer' }],
  EDUCATION: [{ 'School Name': 'Northgate State' }],
  SKILLS: [{ Name: 'TypeScript' }],
  CERTIFICATIONS: [{ Name: 'AWS SAA' }],
  COURSES: [{ Name: 'Distributed Systems' }],
  HONORS: [{ Title: 'Best Paper' }],
  LANGUAGES: [{ Name: 'Dutch' }],
  PROJECTS: [{ Title: 'Evidence Ledger' }],
  PUBLICATIONS: [{ Name: 'On Renovation' }],
  MEMBER_SHARE_INFO: [{ Date: '2026-08-01 10:00:00', ShareCommentary: 'A post the member wrote.' }],
};

let dir: string;
let db: SqliteDriver;
let eventId = 1;

function client(
  rows: Record<string, Array<Record<string, unknown>>> = ROWS,
  events: Array<Record<string, unknown>> = [],
): DmaSource & DmaChangelogSource {
  return {
    assertDomainAllowed() {},
    async fetchSnapshotDomain(domain: string) {
      return { domain, rows: rows[domain] ?? [] };
    },
    async fetchChangelog() {
      return events;
    },
  };
}

function messageEvent(): Record<string, unknown> {
  return {
    id: eventId++,
    activityId: `msg-${eventId}`,
    resourceName: 'messages',
    resourceId: 'm1',
    method: 'CREATE',
    capturedAt: EVENT_MS,
    processedAt: EVENT_MS + 1000,
    activity: { content: 'PRIVATE MESSAGE BODY' },
  };
}

function headlineEvent(): Record<string, unknown> {
  return {
    id: eventId++,
    activityId: `hl-${eventId}`,
    resourceName: 'people',
    resourceId: 'urn:li:person:abc',
    method: 'PARTIAL_UPDATE',
    capturedAt: EVENT_MS,
    processedAt: EVENT_MS + 1000,
    activity: { headline: 'Staff Engineer' },
  };
}

beforeEach(() => {
  eventId = 1;
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-purge-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);
  db.run(
    `UPDATE capabilities SET status = 'verified', blockers_json = '[]'
      WHERE feature IN ('linkedin.dma_snapshot', 'linkedin.dma_changelog')`,
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('portability data deletion', () => {
  it('refuses without confirmation and rejects a malformed cutoff', () => {
    expect(() => purgeDmaLane(db, { confirm: false })).toThrowError(DomainError);
    expect(() => purgeDmaLane(db, { confirm: true, before: 'not-a-date' })).toThrowError(
      DomainError,
    );
  });

  it('normalizes the cutoff so a second-precision timestamp still matches', async () => {
    await readLatestProfileFromDma(db, client(ROWS), { now: T10 });
    await readLatestProfileFromDma(db, client({ ...ROWS, SKILLS: [{ Name: 'Rust' }] }), {
      now: T12,
    });
    // Stored timestamps carry milliseconds; a caller-supplied cutoff usually
    // does not, and these are lexical comparisons on TEXT.
    const result = purgeDmaLane(db, { confirm: true, before: '2026-08-12T11:00:00Z', now: T12 });
    expect(result.before).toBe('2026-08-12T11:00:00.000Z');
    expect(result.deleted.snapshot_observations).toBe(1);
    expect(dmaLaneFootprint(db).snapshot_observations).toBe(1);
  });

  it('deletes every trace of the lane, including message payloads', async () => {
    await syncFromDma(db, client(ROWS), { now: T10 });
    await readLatestProfileFromDma(db, client(ROWS, [messageEvent(), headlineEvent()]), {
      now: T11,
    });

    const before = dmaLaneFootprint(db);
    expect(before.changelog_events).toBe(2);
    expect(before.dma_snapshots).toBeGreaterThan(0);
    expect(before.published_posts).toBe(1);
    expect(before.raw_payload_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(db.all('SELECT event_json FROM dma_changelog_events'))).toContain(
      'PRIVATE MESSAGE BODY',
    );

    const result = purgeDmaLane(db, { confirm: true, now: T12 });

    expect(result.mode).toBe('purge');
    expect(result.before).toBeNull();
    expect(result.deleted.changelog_events).toBe(2);
    expect(result.deleted.published_posts).toBe(1);
    // Measured, not a placeholder.
    expect(result.deleted.raw_payload_bytes).toBe(before.raw_payload_bytes);
    expect(result.retained_snapshots).toEqual([]);
    expect(result.fully_deleted).toBe(true);
    expect(result.cursor_reset).toBe(true);

    const after = dmaLaneFootprint(db);
    expect(after).toMatchObject({
      changelog_events: 0,
      snapshot_observations: 0,
      snapshot_domain_results: 0,
      dma_snapshots: 0,
      snapshot_fields: 0,
      published_posts: 0,
      raw_payload_bytes: 0,
    });
    // Not merely unreferenced — gone from the file's rows.
    expect(JSON.stringify(db.all('SELECT * FROM dma_changelog_events'))).not.toContain(
      'PRIVATE MESSAGE BODY',
    );
    expect(db.get('SELECT * FROM dma_changelog_watermarks')).toBeUndefined();
    // Per-domain sync notes name observations that no longer exist.
    expect(db.all('SELECT * FROM dma_sync_state')).toEqual([]);
    expect(latestSnapshot(db)).toBeNull();
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it('leaves everything that is not portability data alone', async () => {
    updateSection(db, {
      section_key: 'headline',
      content_text: 'Canonical headline the member wrote',
      claim_ids: [],
      author: 'user',
      based_on_revision: null,
    });
    // An export-imported snapshot is the member's own data, not LinkedIn's.
    db.run(
      `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
       VALUES ('src_export', 'linkedin_export', 'C:/export', 'Export', 'personal_doc', 'enabled', ?)`,
      T10.toISOString(),
    );
    db.run(
      `INSERT INTO linkedin_snapshots (id, source_kind, source_id, taken_at, imported_at, retention_class, version)
       VALUES ('snp_export', 'export_csv', 'src_export', ?, ?, 'durable_user', 99)`,
      T10.toISOString(),
      T10.toISOString(),
    );
    db.run(
      `INSERT INTO snapshot_fields (snapshot_id, field_key, value_text, char_count, raw_json)
       VALUES ('snp_export', 'headline', 'From the export', 15, NULL)`,
    );
    await syncFromDma(db, client(ROWS), { now: T10 });
    const auditBefore = db.all('SELECT seq FROM audit_events').length;

    purgeDmaLane(db, { confirm: true, now: T12 });

    expect(db.all('SELECT * FROM canonical_revisions')).toHaveLength(1);
    expect(
      db.get("SELECT value_text FROM snapshot_fields WHERE snapshot_id = 'snp_export'")?.[
        'value_text'
      ],
    ).toBe('From the export');
    expect(db.get("SELECT id FROM linkedin_snapshots WHERE id = 'snp_export'")).toBeDefined();
    // The audit chain is append-only: purging adds a record, never removes one.
    expect(db.all('SELECT seq FROM audit_events').length).toBeGreaterThan(auditBefore);
    expect(verifyAuditChain(db).valid).toBe(true);
    const purgeEvent = db.get(
      "SELECT payload_json FROM audit_events WHERE event_type = 'dma.purge'",
    )!;
    expect(String(purgeEvent['payload_json'])).toContain('changelog_events');
    // Counts only — the deleted data must not be re-recorded in an exportable log.
    expect(String(purgeEvent['payload_json'])).not.toContain('PRIVATE');
  });

  it('keeps a snapshot a change set is based on, and says why', async () => {
    await syncFromDma(db, client(ROWS), { now: T10 });
    const snapshotId = latestSnapshot(db)!.id;
    db.run(
      `INSERT INTO change_sets (id, title, base_snapshot_id, state, created_at)
       VALUES ('chg_1', 'Headline refresh', ?, 'open', ?)`,
      snapshotId,
      T10.toISOString(),
    );

    const result = purgeDmaLane(db, { confirm: true, now: T12 });

    expect(result.retained_snapshots).toEqual([
      { snapshot_id: snapshotId, reason: expect.stringContaining('chg_1') },
    ]);
    // Kept, because deleting it would delete the member's own change set.
    expect(db.get('SELECT id FROM linkedin_snapshots WHERE id = ?', snapshotId)).toBeDefined();
    expect(db.get('SELECT id FROM change_sets WHERE id = ?', 'chg_1')).toBeDefined();
    // Everything with no such tie still went.
    expect(dmaLaneFootprint(db).changelog_events).toBe(0);
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it('prunes history to a cutoff while keeping the current observed profile', async () => {
    await readLatestProfileFromDma(db, client(ROWS), { now: T10 });
    // A second, different observation so there is genuine history to prune.
    const moved = { ...ROWS, SKILLS: [{ Name: 'TypeScript' }, { Name: 'Rust' }] };
    await readLatestProfileFromDma(db, client(moved, [headlineEvent()]), { now: T12 });

    const before = dmaLaneFootprint(db);
    expect(before.snapshot_observations).toBe(2);
    expect(before.dma_snapshots).toBe(2);

    const result = purgeDmaLane(db, {
      confirm: true,
      before: T11.toISOString(),
      now: T12,
    });

    expect(result.mode).toBe('prune');
    expect(result.cursor_reset).toBe(false);
    // The cursor survives: pruning removes old rows, and the cursor tracks the
    // newest event.
    expect(db.get('SELECT * FROM dma_changelog_watermarks')).toBeDefined();

    const after = dmaLaneFootprint(db);
    expect(after.snapshot_observations).toBe(1);
    // The current observed profile is intact and still complete.
    const snapshot = latestSnapshot(db)!;
    expect(snapshot.fields['skills']?.value_text).toBe('TypeScript, Rust');
    expect(snapshot.fields['headline']?.value_text).toBe('Full-Stack Web Developer');
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it('keeps the newest snapshot AND its observation when everything predates the cutoff', async () => {
    await readLatestProfileFromDma(db, client(ROWS), { now: T10 });
    purgeDmaLane(db, { confirm: true, before: T12.toISOString(), now: T12 });

    const footprint = dmaLaneFootprint(db);
    expect(footprint.dma_snapshots).toBe(1);
    // Deleting the observation would orphan the snapshot the prune kept, leave
    // the next read with no previous observation, and leave the freshness
    // baseline with nothing to anchor on — reporting a stale profile as clean.
    expect(footprint.snapshot_observations).toBe(1);
    expect(latestSnapshot(db)!.fields['headline']?.value_text).toBe('Full-Stack Web Developer');

    // Proven, not assumed: the next read still reuses that snapshot rather than
    // minting a duplicate, and still detects a pending edit.
    const next = await readLatestProfileFromDma(db, client(ROWS, [headlineEvent()]), {
      now: new Date('2026-08-12T13:00:00.000Z'),
    });
    expect(next.observation.snapshot_created).toBe(false);
    expect(next.freshness.newer_relevant_event_count).toBe(1);
  });

  it('refuses a cutoff that would make pruning a full purge, or one with no offset', () => {
    // prune is gated only on confirm: true, so a far-future cutoff would delete
    // the whole lane through the ungated variant and bypass the phrase.
    expect(() =>
      purgeDmaLane(db, { confirm: true, before: '2099-01-01T00:00:00Z', now: T12 }),
    ).toThrowError(/must be in the past/);
    // An offset-less ISO string is parsed in the host timezone, so the real
    // cutoff would silently shift by the machine's UTC offset.
    expect(() =>
      purgeDmaLane(db, { confirm: true, before: '2026-08-12T00:00:00', now: T12 }),
    ).toThrowError(/explicit UTC offset/);
  });

  it('never prunes changelog events LinkedIn would still serve', async () => {
    await readLatestProfileFromDma(db, client(ROWS, [headlineEvent()]), { now: T10 });
    // An event received long ago: pure accumulation, LinkedIn will not serve it
    // again either way.
    db.run(
      `INSERT INTO dma_changelog_events
       (event_hash, event_json, requested_since_ms, received_at, retention_class,
        resource_name, method, processed_at_ms)
       VALUES ('old-hash', '{"id":999}', 0, '2026-05-01T00:00:00.000Z', 'durable_dma',
               'people', 'PARTIAL_UPDATE', 1)`,
    );
    expect(dmaLaneFootprint(db).changelog_events).toBe(2);

    // A cutoff of "yesterday" would naively delete both.
    const result = purgeDmaLane(db, {
      confirm: true,
      before: '2026-08-11T00:00:00.000Z',
      now: T12,
    });

    expect(result.deleted.changelog_events).toBe(1);
    const surviving = db.all('SELECT event_hash FROM dma_changelog_events');
    expect(surviving).toHaveLength(1);
    expect(String(surviving[0]!['event_hash'])).not.toBe('old-hash');
    // The recent event survives, so the pending edit is still reported.
    const next = await readLatestProfileFromDma(db, client(ROWS, [headlineEvent()]), {
      now: new Date('2026-08-12T13:00:00.000Z'),
    });
    expect(next.freshness.newer_relevant_event_count).toBe(1);
  });

  it('keeps a snapshot that surviving observations still point at', async () => {
    // Identical content across reads means one snapshot shared by many
    // observations — the case the observation table exists for.
    await readLatestProfileFromDma(db, client(ROWS), { now: T10 });
    const shared = latestSnapshot(db)!.id;
    await readLatestProfileFromDma(db, client(ROWS), { now: T12 });
    expect(latestSnapshot(db)!.id).toBe(shared);

    // The snapshot's imported_at predates the cutoff, but an observation newer
    // than the cutoff still references it.
    purgeDmaLane(db, { confirm: true, before: T11.toISOString(), now: T12 });

    expect(db.get('SELECT id FROM linkedin_snapshots WHERE id = ?', shared)).toBeDefined();
    expect(latestSnapshot(db)!.fields['headline']?.value_text).toBe('Full-Stack Web Developer');
  });

  it('does not touch post history when pruning', async () => {
    await syncFromDma(db, client(ROWS), { now: T12 });
    expect(dmaLaneFootprint(db).published_posts).toBe(1);
    // durable_dma posts are stamped with the sync time, not the post date, so
    // pruning by the cutoff would delete an archive spanning years.
    const result = purgeDmaLane(db, { confirm: true, before: T11.toISOString(), now: T12 });
    expect(result.deleted.published_posts).toBe(0);
    expect(dmaLaneFootprint(db).published_posts).toBe(1);
  });

  it('keeps a snapshot an applied patch was verified against, and says so', async () => {
    // Two snapshots, so the one under test is pinned by the patch alone. With
    // the change set based on the same snapshot, that pin fires first and this
    // one is never reached.
    await syncFromDma(db, client(ROWS), { now: T10 });
    const olderId = latestSnapshot(db)!.id;
    await syncFromDma(
      db,
      client({ ...ROWS, PROFILE: [{ Headline: 'Staff Engineer', 'First Name': 'Alex' }] }),
      { now: T11 },
    );
    const snapshotId = latestSnapshot(db)!.id;
    expect(snapshotId).not.toBe(olderId);
    db.run(
      `INSERT INTO change_sets (id, title, base_snapshot_id, state, created_at)
       VALUES ('chg_base', 'Base', ?, 'open', ?)`,
      olderId,
      T10.toISOString(),
    );
    db.run(
      `INSERT INTO field_patches
       (id, change_set_id, field_key, old_text, new_text, char_count, char_limit_ok,
        claim_ids_json, kind, state, applied_verified_snapshot_id, revision_hash,
        created_at, updated_at)
       VALUES ('pat_1', 'chg_base', 'headline', 'old', 'new', 3, 1, '[]',
               'required_fix', 'applied', ?, 'rev', ?, ?)`,
      snapshotId,
      T10.toISOString(),
      T10.toISOString(),
    );

    const result = purgeDmaLane(db, { confirm: true, now: T12 });

    // Clearing the pointer would report the patch as unverified forever, with
    // no snapshot left to re-verify against.
    expect(
      db.get("SELECT applied_verified_snapshot_id FROM field_patches WHERE id = 'pat_1'")?.[
        'applied_verified_snapshot_id'
      ],
    ).toBe(snapshotId);
    // A purge that had to keep LinkedIn-derived text says so rather than
    // reporting a deletion request as fully honoured.
    expect(result.fully_deleted).toBe(false);
    const kept = result.retained_snapshots.find((r) => r.snapshot_id === snapshotId);
    expect(kept?.reason).toMatch(/was verified against it/i);
    expect(kept?.reason).toContain('remains stored');
  });

  it('leaves no dangling pointer that would silently disable lag detection', async () => {
    await readLatestProfileFromDma(db, client(ROWS), { now: T10 });
    const moved = { ...ROWS, SKILLS: [{ Name: 'Rust' }] };
    await readLatestProfileFromDma(db, client(moved), { now: T11 });
    await readLatestProfileFromDma(db, client(moved, [headlineEvent()]), { now: T12 });

    purgeDmaLane(db, { confirm: true, before: T11.toISOString(), now: T12 });

    // previous_observation_id is resolved with a subquery and is not a foreign
    // key, so a dangling one turns the freshness baseline off silently.
    const dangling = db.all(
      `SELECT id FROM dma_snapshot_observations
        WHERE previous_observation_id IS NOT NULL
          AND previous_observation_id NOT IN (SELECT id FROM dma_snapshot_observations)`,
    );
    expect(dangling).toEqual([]);
    const danglingRaw = db.all(
      `SELECT observation_id FROM dma_snapshot_domain_results
        WHERE raw_same_as_observation_id IS NOT NULL
          AND raw_same_as_observation_id NOT IN (SELECT id FROM dma_snapshot_observations)`,
    );
    expect(danglingRaw).toEqual([]);

    // And a read afterwards still detects the pending edit rather than
    // reporting a clean profile.
    const after = await readLatestProfileFromDma(db, client(moved, [headlineEvent()]), {
      now: new Date('2026-08-12T13:00:00.000Z'),
    });
    expect(after.freshness.newer_relevant_event_count).toBeGreaterThan(0);
  });

  it('reports the lane footprint in the retention policy', async () => {
    await syncFromDma(db, client(ROWS), { now: T10 });
    const summary = retentionSummary(db);
    expect(summary.dma_lane.dma_snapshots).toBeGreaterThan(0);
    expect(summary.policy['durable_dma']).toContain('purge_dma');
    purgeDmaLane(db, { confirm: true, now: T12 });
    expect(retentionSummary(db).dma_lane.dma_snapshots).toBe(0);
  });

  it('puts the lane back to never-synced, so a later sync starts fresh', async () => {
    await readLatestProfileFromDma(db, client(ROWS, [headlineEvent()]), { now: T10 });
    purgeDmaLane(db, { confirm: true, now: T11 });

    const starts: number[] = [];
    const spy: DmaSource & DmaChangelogSource = {
      assertDomainAllowed() {},
      async fetchSnapshotDomain(domain: string) {
        return { domain, rows: ROWS[domain] ?? [] };
      },
      async fetchChangelog(sinceMs: number) {
        starts.push(sinceMs);
        return [];
      },
    };
    await readLatestProfileFromDma(db, spy, { now: T12 });
    // The full retained window, not a cursor pointing past data that is gone.
    expect(starts[0]).toBe(T12.getTime() - 28 * 24 * 60 * 60 * 1000);
  });
});
