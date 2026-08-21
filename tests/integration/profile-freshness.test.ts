import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  getProfile,
  latestSnapshot,
  readLatestProfileFromDma,
  seedCanonicalSections,
  seedCapabilities,
  syncFromDma,
  updateSection,
  verifyAuditChain,
  type DmaChangelogSource,
  type DmaSource,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';

// The behaviour under test is the one observed live on 2026-08-12: a brand new
// Snapshot read came back with a fingerprint identical to reads from two days
// earlier, while the Changelog already held fifteen profile events. Everything
// here is deterministic — injected clocks, injected ports, no network.

const T10 = new Date('2026-08-12T10:00:00.000Z');
const T11 = new Date('2026-08-12T11:00:00.000Z');
const T12 = new Date('2026-08-12T12:00:00.000Z');
const AFTER_T10 = T10.getTime() + 20 * 60 * 1000;

// Every profile domain answers. A domain returning no rows is now a reportable
// state in its own right (LinkedIn's page-zero "No data found" is identical
// whether the member has no entries or the domain is not collated yet), so a
// fixture that left seven domains empty could never produce a clean read.
const ROWS: Record<string, Array<Record<string, unknown>>> = {
  PROFILE: [
    {
      'First Name': 'Alex',
      'Last Name': 'Rivera',
      Headline: 'Full-Stack Web Developer',
      Summary: 'Builds local-first systems.',
    },
  ],
  POSITIONS: [
    {
      'Company Name': 'Vale Wind Power',
      Title: 'Web Developer',
      'Started On': 'Jun 2020',
    },
  ],
  EDUCATION: [{ 'School Name': 'Northgate State University', 'Degree Name': 'BSc' }],
  SKILLS: [{ Name: 'TypeScript' }, { Name: 'Python' }],
  CERTIFICATIONS: [{ Name: 'AWS SAA', Authority: 'Amazon' }],
  COURSES: [{ Name: 'Distributed Systems' }],
  HONORS: [{ Title: 'Best Paper' }],
  LANGUAGES: [{ Name: 'Dutch', Proficiency: 'Native' }],
  PROJECTS: [{ Title: 'Evidence Ledger' }],
  PUBLICATIONS: [{ Name: 'On Renovation' }],
};

let dir: string;
let db: SqliteDriver;

interface EventInit {
  activityId: string;
  resourceName: string;
  resourceId?: string | null;
  method: string;
  activity?: Record<string, unknown>;
  activityStatus?: string;
  capturedAt?: number;
  processedAt?: number;
  configVersion?: number;
}

let nextEventId = 1;

function event(init: EventInit): Record<string, unknown> {
  const captured = init.capturedAt ?? AFTER_T10;
  const row: Record<string, unknown> = {
    id: nextEventId++,
    activityId: init.activityId,
    owner: 'urn:li:person:abc',
    actor: 'urn:li:person:abc',
    resourceName: init.resourceName,
    method: init.method,
    configVersion: init.configVersion ?? 3,
    capturedAt: captured,
    processedAt: init.processedAt ?? captured + 60_000,
  };
  if (init.resourceId !== null) row['resourceId'] = init.resourceId ?? 'res-1';
  if (init.activity !== undefined) row['activity'] = init.activity;
  if (init.activityStatus !== undefined) row['activityStatus'] = init.activityStatus;
  return row;
}

interface Harness extends DmaSource, DmaChangelogSource {
  snapshotCalls: string[];
  changelogCalls: number[];
  /** Every upstream call in the order it was made. */
  callOrder: string[];
  observationRowsDuringFetch: number[];
}

function harness(opts: {
  rows?: Record<string, Array<Record<string, unknown>>>;
  events?: Array<Record<string, unknown>>;
  failDomains?: string[];
}): Harness {
  const rows = opts.rows ?? ROWS;
  const snapshotCalls: string[] = [];
  const changelogCalls: number[] = [];
  const callOrder: string[] = [];
  const observationRowsDuringFetch: number[] = [];
  return {
    snapshotCalls,
    changelogCalls,
    callOrder,
    observationRowsDuringFetch,
    assertDomainAllowed(domain: string) {
      if (domain === 'INBOX') throw new Error('blocked domain');
    },
    async fetchSnapshotDomain(domain: string) {
      snapshotCalls.push(domain);
      callOrder.push(`snapshot:${domain}`);
      // Proves nothing was persisted before the network work finished:
      // withWriteTx re-runs its body on SQLITE_BUSY, so a request issued from
      // inside a transaction would be issued twice.
      observationRowsDuringFetch.push(db.all('SELECT id FROM dma_snapshot_observations').length);
      if (opts.failDomains?.includes(domain)) throw new Error(`LinkedIn 503 on ${domain}`);
      return { domain, rows: rows[domain] ?? [] };
    },
    async fetchChangelog(sinceMs: number) {
      changelogCalls.push(sinceMs);
      callOrder.push('changelog');
      return opts.events ?? [];
    },
  };
}

function openLanes(): void {
  db.run(
    `UPDATE capabilities SET status = 'verified', blockers_json = '[]'
      WHERE feature IN ('linkedin.dma_snapshot', 'linkedin.dma_changelog')`,
  );
}

beforeEach(() => {
  nextEventId = 1;
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-fresh-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);
  openLanes();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('live profile read', () => {
  it('fetches every profile domain, changelog first, and never writes before the network is done', async () => {
    const client = harness({});
    const result = await readLatestProfileFromDma(db, client, { now: T10 });

    expect(client.changelogCalls).toHaveLength(1);
    // Changelog strictly first: it is what makes lag detectable, since the
    // Snapshot response carries no timestamp of its own.
    expect(client.callOrder[0]).toBe('changelog');
    expect(client.callOrder.filter((c) => c === 'changelog')).toHaveLength(1);
    expect(client.snapshotCalls).toEqual([
      'PROFILE',
      'POSITIONS',
      'EDUCATION',
      'SKILLS',
      'CERTIFICATIONS',
      'COURSES',
      'HONORS',
      'LANGUAGES',
      'PROJECTS',
      'PUBLICATIONS',
    ]);
    expect(client.observationRowsDuringFetch.every((n) => n === 0)).toBe(true);
    expect(result.observed['headline']).toBe('Full-Stack Web Developer');
    expect(result.snapshot_id).not.toBeNull();
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it('says not_guaranteed even on a clean observation with nothing pending', async () => {
    const result = await readLatestProfileFromDma(db, harness({}), { now: T10 });
    expect(result.freshness.guarantee).toBe('not_guaranteed');
    expect(result.freshness.status).toBe('observed_no_newer_profile_event');
    expect(JSON.stringify(result)).not.toMatch(/guaranteed_current|confirmed_current/);
    expect(result.freshness.recommended_next_action.length).toBeGreaterThan(0);
  });

  it('never overwrites the canonical profile', async () => {
    updateSection(db, {
      section_key: 'headline',
      content_text: 'Canonical headline nobody may touch',
      claim_ids: [],
      author: 'user',
      based_on_revision: null,
    });
    const before = getProfile(db, ['headline']).headline!;

    await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'a1',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: { headline: { localized: { en_US: 'Something else entirely' } } },
          }),
        ],
      }),
      { now: T10 },
    );

    const after = getProfile(db, ['headline']).headline!;
    expect(after.id).toBe(before.id);
    expect(after.content_text).toBe('Canonical headline nobody may touch');
    expect(db.all('SELECT * FROM canonical_revisions')).toHaveLength(1);
  });
});

describe('upstream snapshot lag', () => {
  it('reports lag when the Snapshot repeats itself while the Changelog has moved on', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });

    const events = [
      event({
        activityId: 'a1',
        resourceName: 'people',
        method: 'PARTIAL_UPDATE',
        activity: { headline: { localized: { en_US: 'Staff Engineer' } } },
      }),
      event({
        activityId: 'a2',
        resourceName: 'people/positions',
        resourceId: 'p9',
        method: 'CREATE',
        activity: { title: 'Staff Engineer' },
      }),
    ];
    const second = await readLatestProfileFromDma(db, harness({ events }), { now: T11 });

    expect(second.observation.content_identical_to_previous).toBe(true);
    expect(second.observation.snapshot_created).toBe(false);
    expect(second.freshness.status).toBe('upstream_snapshot_lag_detected');
    expect(second.freshness.newer_relevant_event_count).toBe(2);
    expect(second.freshness.reasons.join(' ')).toContain('identical');
    expect(second.freshness.recommended_next_action).toContain('later');
    // The lagging Snapshot is still the observed profile; the overlay is not
    // merged into it.
    expect(second.observed['headline']).toBe('Full-Stack Web Developer');
    expect(second.freshness.event_derived.person['headline']).toBe('Staff Engineer');
  });

  it('still reports lag as a secondary signal when a domain also failed', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });

    const second = await readLatestProfileFromDma(
      db,
      harness({
        failDomains: ['SKILLS'],
        events: [
          event({
            activityId: 'a1',
            resourceName: 'people/positions',
            resourceId: 'p9',
            method: 'CREATE',
            activity: { title: 'x' },
          }),
        ],
      }),
      { now: T11 },
    );

    expect(second.freshness.status).toBe('partial_domain_fetch');
    expect(second.freshness.secondary_signals).toContain('upstream_snapshot_lag_detected');
    expect(second.freshness.domains.failed).toEqual(['SKILLS']);
  });

  it('does not erase a previously populated domain that comes back empty', async () => {
    const first = await readLatestProfileFromDma(db, harness({}), { now: T10 });
    expect(first.observed['skills']).toBe('TypeScript, Python');

    const thin = { ...ROWS, SKILLS: [] };
    const second = await readLatestProfileFromDma(db, harness({ rows: thin }), { now: T11 });

    expect(second.observed['skills']).toBe('TypeScript, Python');
    const skills = second.domains.find((d) => d.domain === 'SKILLS')!;
    expect(skills.status).toBe('empty_or_not_ready');
    expect(skills.carried_forward_from).toBe(first.observation.id);
    expect(second.freshness.domains.carried_forward).toEqual(['SKILLS']);
    // Carried data can never be part of a clean verdict.
    expect(second.freshness.status).toBe('partial_domain_fetch');
    expect(latestSnapshot(db)!.fields['skills']?.value_text).toBe('TypeScript, Python');
  });
});

// Every case here was a real defect found by review after the first
// implementation passed. Each one is the exact scenario that broke.
describe('freshness regressions', () => {
  it('keeps reporting lag for as long as the Snapshot stays stale', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });

    const events = [
      event({
        activityId: 'a1',
        resourceName: 'people',
        method: 'PARTIAL_UPDATE',
        activity: { headline: 'Staff Engineer' },
      }),
    ];
    const second = await readLatestProfileFromDma(db, harness({ events }), { now: T11 });
    expect(second.freshness.status).toBe('upstream_snapshot_lag_detected');

    // Third read, same stale Snapshot, same pending edit. Anchoring "newer" on
    // the previous read made the lag vanish here while it was still happening.
    const third = await readLatestProfileFromDma(db, harness({ events }), { now: T12 });
    expect(third.observation.content_identical_to_previous).toBe(true);
    expect(third.observed['headline']).toBe('Full-Stack Web Developer');
    expect(third.freshness.newer_relevant_event_count).toBe(1);
    expect(third.freshness.status).toBe('upstream_snapshot_lag_detected');

    // And it clears the moment LinkedIn actually materializes the edit.
    const moved = {
      ...ROWS,
      PROFILE: [{ ...ROWS['PROFILE']![0], Headline: 'Staff Engineer' }],
    };
    const fourth = await readLatestProfileFromDma(db, harness({ rows: moved, events }), {
      now: new Date('2026-08-12T13:00:00.000Z'),
    });
    expect(fourth.observation.content_identical_to_previous).toBe(false);
    const fifth = await readLatestProfileFromDma(db, harness({ rows: moved, events }), {
      now: new Date('2026-08-12T14:00:00.000Z'),
    });
    expect(fifth.freshness.newer_relevant_event_count).toBe(0);
    expect(fifth.freshness.status).toBe('observed_no_newer_profile_event');
  });

  it('counts an event LinkedIn processed after the last read even though the member acted before it', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });

    // Member edited at 09:55 — before read 1 — but LinkedIn only processed it
    // at 10:30, so it could not have been in read 1's Snapshot. Comparing
    // capturedAt against our own clock declared it old and hid the lag.
    const second = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'a1',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: { headline: 'Staff Engineer' },
            capturedAt: Date.parse('2026-08-12T09:55:00.000Z'),
            processedAt: Date.parse('2026-08-12T10:30:00.000Z'),
          }),
        ],
      }),
      { now: T11 },
    );

    expect(second.freshness.newer_relevant_event_count).toBe(1);
    expect(second.freshness.status).toBe('upstream_snapshot_lag_detected');
  });

  it('orders the overlay by when the member acted, not by when LinkedIn processed', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });

    // A CREATE that failed and was replayed an hour later, and a DELETE the
    // member performed in between. Ordering on processedAt replayed the CREATE
    // last and resurrected a position the member had deleted.
    const created = AFTER_T10;
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'c1',
            resourceName: 'people/positions',
            resourceId: 'p1',
            method: 'CREATE',
            activity: { title: 'A' },
            activityStatus: 'FAILURE',
            capturedAt: created,
            processedAt: created + 1_000,
          }),
          event({
            activityId: 'd1',
            resourceName: 'people/positions',
            resourceId: 'p1',
            method: 'DELETE',
            capturedAt: created + 10_000,
            processedAt: created + 11_000,
          }),
          event({
            activityId: 'c1',
            resourceName: 'people/positions',
            resourceId: 'p1',
            method: 'CREATE',
            activity: { title: 'A' },
            activityStatus: 'SUCCESSFUL_REPLAY',
            capturedAt: created,
            processedAt: created + 60_000,
          }),
        ],
      }),
      { now: T11 },
    );

    expect(result.freshness.event_derived.positions).toEqual([]);
    expect(result.freshness.applied_overlay.map((c) => c.kind)).toEqual([
      'position_created',
      'position_deleted',
    ]);
    expect(
      result.freshness.unresolved_changes.filter((c) => c.reason === 'unknown_resource_delete'),
    ).toEqual([]);
  });

  it('does not let a replayed older edit overwrite a newer one', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const first = AFTER_T10;
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'h1',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: { headline: 'FIRST EDIT' },
            activityStatus: 'FAILURE',
            capturedAt: first,
            processedAt: first + 1_000,
          }),
          event({
            activityId: 'h2',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: { headline: 'SECOND EDIT' },
            capturedAt: first + 30_000,
            processedAt: first + 31_000,
          }),
          event({
            activityId: 'h1',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: { headline: 'FIRST EDIT' },
            activityStatus: 'SUCCESSFUL_REPLAY',
            capturedAt: first,
            processedAt: first + 90_000,
          }),
        ],
      }),
      { now: T11 },
    );
    expect(result.freshness.event_derived.person['headline']).toBe('SECOND EDIT');
  });

  it('does not publish a truncated profile when the caller narrows the domains', async () => {
    const full = await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const fullKeys = Object.keys(full.observed).sort();
    expect(fullKeys).toContain('headline');
    expect(fullKeys).toContain('experience');

    const narrow = await readLatestProfileFromDma(db, harness({}), {
      now: T11,
      domains: ['SKILLS'],
    });

    // The snapshot must remain a whole profile: latestSnapshot() is the default
    // base for linkedin_profile_diff and linkedin_changeset_generate, which
    // would otherwise conclude the member deleted everything else.
    expect(Object.keys(narrow.observed).sort()).toEqual(fullKeys);
    expect(latestSnapshot(db)!.fields['headline']?.value_text).toBe('Full-Stack Web Developer');
    expect(narrow.observation.snapshot_created).toBe(false);
    // And it says so rather than presenting itself as a full read.
    expect(narrow.freshness.domains.not_requested).toContain('PROFILE');
    expect(narrow.freshness.domains.requested).toEqual(['SKILLS']);
    expect(narrow.freshness.status).toBe('partial_domain_fetch');
  });

  it('carries forward from a snapshot that migration 017 backfilled', () => {
    // A database as migration 017 leaves it: a legacy DMA snapshot and an
    // observation row, but no domain-result rows to look up.
    db.run(
      `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
       VALUES ('src_legacy', 'manual', 'linkedin://dma', 'LinkedIn DMA API', 'personal_doc', 'enabled', ?)`,
      T10.toISOString(),
    );
    db.run(
      `INSERT INTO linkedin_snapshots (id, source_kind, source_id, taken_at, imported_at, retention_class, version)
       VALUES ('snp_legacy', 'dma_snapshot', 'src_legacy', NULL, ?, 'durable_dma', 1)`,
      T10.toISOString(),
    );
    for (const [key, text] of [
      ['headline', 'Full-Stack Web Developer'],
      ['skills', 'TypeScript, Python'],
    ] as const) {
      db.run(
        `INSERT INTO snapshot_fields (snapshot_id, field_key, value_text, char_count, raw_json)
         VALUES ('snp_legacy', ?, ?, ?, NULL)`,
        key,
        text,
        text.length,
      );
    }
    db.run(
      `INSERT INTO dma_snapshot_observations
       (id, snapshot_id, requested_at, request_completed_at, observed_at, content_identical, backfilled, retention_class)
       VALUES ('dmo_legacy_snp_legacy', 'snp_legacy', ?, ?, ?, 0, 1, 'durable_dma')`,
      T10.toISOString(),
      T10.toISOString(),
      T10.toISOString(),
    );

    return readLatestProfileFromDma(db, harness({ rows: { ...ROWS, SKILLS: [] } }), {
      now: T11,
    }).then((result) => {
      expect(result.observed['skills']).toBe('TypeScript, Python');
      const skills = result.domains.find((d) => d.domain === 'SKILLS')!;
      expect(skills.carried_forward_from).toBe('dmo_legacy_snp_legacy');
      expect(result.freshness.domains.carried_forward).toContain('SKILLS');
      expect(result.freshness.status).toBe('partial_domain_fetch');
    });
  });

  it('does not drop a section when LinkedIn answers with rows it cannot render', async () => {
    const first = await readLatestProfileFromDma(db, harness({}), { now: T10 });
    expect(first.observed['skills']).toBe('TypeScript, Python');

    // status is 'populated' (rows came back), but none of the recognised
    // columns match. Carry-forward used to run only for non-populated domains,
    // so the section vanished from the snapshot with a clean verdict.
    const second = await readLatestProfileFromDma(
      db,
      harness({ rows: { ...ROWS, SKILLS: [{ Unexpected: 'renamed column' }] } }),
      { now: T11 },
    );

    // The unknown row is still rendered rather than discarded.
    expect(second.observed['skills']).toBe('Unexpected: renamed column');
    expect(latestSnapshot(db)!.fields['skills']?.value_text).toBe('Unexpected: renamed column');

    // And when even that yields nothing, the previous value is carried, stamped.
    const third = await readLatestProfileFromDma(
      db,
      harness({ rows: { ...ROWS, SKILLS: [{ Name: '   ' }] } }),
      { now: T12 },
    );
    expect(third.observed['skills']).toBe('Unexpected: renamed column');
    expect(third.domains.find((d) => d.domain === 'SKILLS')!.carried_forward_from).toBe(
      second.observation.id,
    );
    expect(third.freshness.domains.carried_forward).toContain('SKILLS');
    expect(third.freshness.status).toBe('partial_domain_fetch');
  });

  it('does not claim content is identical when a failure hid a real change', async () => {
    const v1 = { ...ROWS, PROFILE: [{ Headline: 'ORIGINAL' }] };
    const v2 = { ...ROWS, PROFILE: [{ Headline: 'CHANGED BY THE MEMBER' }] };
    await readLatestProfileFromDma(db, harness({ rows: v1 }), { now: T10 });
    await readLatestProfileFromDma(db, harness({ rows: v1, failDomains: ['PROFILE'] }), {
      now: T11,
    });

    // Read 2 stored PROFILE with a null fingerprint. Picking simply the most
    // recent row made PROFILE incomparable here, so its genuine change was
    // excluded and the read claimed identity — which manufactures a false
    // upstream_snapshot_lag_detected.
    const third = await readLatestProfileFromDma(db, harness({ rows: v2 }), { now: T12 });
    expect(third.observed['headline']).toBe('CHANGED BY THE MEMBER');
    expect(third.observation.content_identical_to_previous).toBe(false);
    expect(third.freshness.content_changed_from_previous).toBe(true);
  });

  it('reports change as unknown rather than true when nothing could be compared', async () => {
    const first = await readLatestProfileFromDma(db, harness({}), { now: T10 });
    // Nothing to compare against on a first observation.
    expect(first.freshness.content_changed_from_previous).toBeNull();
  });

  it('records no raw payload for a domain whose rows were discarded', async () => {
    const capped = new DomainError('INTERNAL', 'did not terminate within 200 pages', {
      blockers: ['snapshot_page_cap'],
    });
    const client: DmaSource & DmaChangelogSource = {
      assertDomainAllowed() {},
      async fetchSnapshotDomain(domain: string) {
        if (domain === 'SKILLS') throw capped;
        return { domain, rows: ROWS[domain] ?? [] };
      },
      async fetchChangelog() {
        return [];
      },
    };
    const result = await readLatestProfileFromDma(db, client, { now: T10 });
    expect(result.domains.find((d) => d.domain === 'SKILLS')!.status).toBe('pagination_incomplete');
    // '[]' here would be indistinguishable from a genuinely empty domain.
    const row = db.get("SELECT raw_json FROM dma_snapshot_domain_results WHERE domain = 'SKILLS'")!;
    expect(row['raw_json']).toBeNull();
  });

  it('caps the overlay lists it returns and reports the true totals', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    // Well past the 200-entry response cap.
    const events = Array.from({ length: 250 }, (_, i) =>
      event({
        activityId: `ghost-${i}`,
        resourceName: 'people/positions',
        resourceId: `missing-${i}`,
        method: 'DELETE',
        capturedAt: AFTER_T10 + i,
      }),
    );
    const result = await readLatestProfileFromDma(db, harness({ events }), { now: T11 });
    expect(result.freshness.unresolved_changes).toHaveLength(200);
    expect(result.freshness.truncated.unresolved_changes).toBe(true);
    expect(result.freshness.truncated.unresolved_changes_total).toBe(250);
    // The newest entries are the ones kept.
    expect(result.freshness.unresolved_changes.at(-1)!.resource_id).toBe('missing-249');
  });

  it('stops the walk on a rejected credential instead of failing ten domains separately', async () => {
    const calls: string[] = [];
    const dead: DmaSource & DmaChangelogSource = {
      assertDomainAllowed() {},
      async fetchSnapshotDomain(domain: string) {
        calls.push(domain);
        throw new DomainError(
          'CAPABILITY_UNAVAILABLE',
          'LinkedIn rejected the access token (401)',
          {
            blockers: ['token_expired_or_revoked'],
          },
        );
      },
      async fetchChangelog() {
        return [];
      },
    };

    await expect(readLatestProfileFromDma(db, dead, { now: T10 })).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      blockers: ['token_expired_or_revoked'],
    });
    // One request, not ten against a token LinkedIn already refused.
    expect(calls).toEqual(['PROFILE']);
    expect(db.all('SELECT id FROM dma_snapshot_observations')).toHaveLength(0);
  });

  it('deduplicates a repeated domain instead of failing after every request', async () => {
    const client = harness({});
    const result = await readLatestProfileFromDma(db, client, {
      now: T10,
      domains: ['SKILLS', 'SKILLS', 'PROFILE'],
    });
    expect(client.snapshotCalls).toEqual(['SKILLS', 'PROFILE']);
    expect(result.domains.map((d) => d.domain)).toEqual(['SKILLS', 'PROFILE']);
  });
});

// A second round of review found ten more. Same rule: each test is the exact
// scenario that broke.
describe('false-clean regressions', () => {
  const HEADLINE_EVENT = () =>
    event({
      activityId: 'pending',
      resourceName: 'people',
      method: 'PARTIAL_UPDATE',
      activity: { headline: 'Staff Engineer' },
    });

  it('never calls a read clean while a domain returned no rows', async () => {
    // Right after onboarding LinkedIn has not collated everything. Answering
    // with no rows is not proof the section is empty, so it cannot be clean.
    const result = await readLatestProfileFromDma(
      db,
      harness({ rows: { ...ROWS, CERTIFICATIONS: [], LANGUAGES: [] } }),
      { now: T10 },
    );
    expect(result.freshness.domains.empty_or_not_ready).toEqual(['CERTIFICATIONS', 'LANGUAGES']);
    expect(result.freshness.status).toBe('partial_domain_fetch');
    expect(result.freshness.reasons.join(' ')).toContain('not proof the section is empty');
  });

  it('warns about lag even when another domain did materialise', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    // SKILLS moved, PROFILE did not, and the pending edit is a headline change.
    // Requiring the whole read to be unchanged hid this entirely.
    const moved = { ...ROWS, SKILLS: [{ Name: 'TypeScript' }, { Name: 'Rust' }] };
    const second = await readLatestProfileFromDma(
      db,
      harness({ rows: moved, events: [HEADLINE_EVENT()] }),
      { now: T11 },
    );
    expect(second.observed['headline']).toBe('Full-Stack Web Developer');
    expect(second.freshness.status).toBe('upstream_snapshot_lag_detected');
    expect(second.freshness.domains.populated).toContain('PROFILE');
  });

  it('does not let a post sync re-anchor the profile baseline', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const second = await readLatestProfileFromDma(db, harness({ events: [HEADLINE_EVENT()] }), {
      now: T11,
    });
    expect(second.freshness.status).toBe('upstream_snapshot_lag_detected');

    // Publishing a post changes MEMBER_SHARE_INFO only. It is not a profile
    // domain, so it must not count as "the Snapshot content moved".
    await syncFromDma(
      db,
      {
        assertDomainAllowed() {},
        async fetchSnapshotDomain(domain: string) {
          if (domain === 'MEMBER_SHARE_INFO') {
            return {
              domain,
              rows: [{ Date: '2026-08-12 11:30:00', ShareCommentary: 'A brand new post.' }],
            };
          }
          return { domain, rows: ROWS[domain] ?? [] };
        },
      },
      { now: T12 },
    );

    const third = await readLatestProfileFromDma(db, harness({ events: [HEADLINE_EVENT()] }), {
      now: new Date('2026-08-12T13:00:00.000Z'),
    });
    expect(third.freshness.status).toBe('upstream_snapshot_lag_detected');
  });

  it('does not let an observation that compared nothing re-anchor the baseline', async () => {
    // read 1 covers PROFILE only, so PUBLICATIONS has never been seen.
    await readLatestProfileFromDma(db, harness({}), { now: T10, domains: ['PROFILE'] });
    const second = await readLatestProfileFromDma(db, harness({ events: [HEADLINE_EVENT()] }), {
      now: T11,
      domains: ['PROFILE'],
    });
    expect(second.freshness.status).toBe('upstream_snapshot_lag_detected');

    // A read of a domain with no prior fingerprint measures nothing, so it
    // cannot be the observation where "content demonstrably moved".
    await readLatestProfileFromDma(db, harness({ events: [HEADLINE_EVENT()] }), {
      now: T12,
      domains: ['PUBLICATIONS'],
    });
    const fourth = await readLatestProfileFromDma(db, harness({ events: [HEADLINE_EVENT()] }), {
      now: new Date('2026-08-12T13:00:00.000Z'),
      domains: ['PROFILE'],
    });
    expect(fourth.freshness.newer_relevant_event_count).toBe(1);
    expect(fourth.freshness.secondary_signals.concat(fourth.freshness.status)).toContain(
      'upstream_snapshot_lag_detected',
    );
  });

  it('flags an overlay where nothing at all could be reconciled', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const moved = { ...ROWS, SKILLS: [{ Name: 'Rust' }] };
    const result = await readLatestProfileFromDma(
      db,
      harness({
        rows: moved,
        events: [
          event({
            activityId: 'orphan',
            resourceName: 'people/positions',
            resourceId: 'never-created',
            method: 'PARTIAL_UPDATE',
            activity: { title: 'Head of Everything' },
          }),
        ],
      }),
      { now: T11 },
    );
    expect(result.freshness.applied_overlay).toEqual([]);
    expect(result.freshness.unresolved_changes).toHaveLength(1);
    // Used to fall through to 'unknown', whose reason says every newer event
    // was reconciled — the opposite of what happened.
    const all = [result.freshness.status, ...result.freshness.secondary_signals];
    expect(all).toContain('event_overlay_partial');
    expect(result.freshness.reasons.join(' ')).not.toContain(
      'every newer profile event was reconciled',
    );
  });

  it('treats a full UPDATE as a replacement, not a merge', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'c1',
            resourceName: 'people/positions',
            resourceId: 'p1',
            method: 'CREATE',
            activity: { title: 'Web Developer', description: 'REMOVED LATER' },
            capturedAt: AFTER_T10,
          }),
          event({
            activityId: 'u1',
            resourceName: 'people/positions',
            resourceId: 'p1',
            method: 'UPDATE',
            activity: { title: 'Web Developer' },
            capturedAt: AFTER_T10 + 60_000,
          }),
        ],
      }),
      { now: T11 },
    );
    // LinkedIn documents UPDATE as a full replacement; merging kept a
    // description the member had already deleted.
    expect(result.freshness.event_derived.positions).toEqual([
      { resource_id: 'p1', fields: { title: 'Web Developer' } },
    ]);
    expect(JSON.stringify(result)).not.toContain('REMOVED LATER');
  });

  it('watches profile sub-resources beyond positions, but nothing outside people/', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'edu',
            resourceName: 'people/educations',
            resourceId: 'e1',
            method: 'PARTIAL_UPDATE',
            activity: { schoolName: 'Northgate State' },
          }),
          event({
            activityId: 'msg',
            resourceName: 'messages',
            resourceId: 'm1',
            method: 'CREATE',
            activity: { content: 'PRIVATE' },
          }),
        ],
      }),
      { now: T11 },
    );
    // An education edit is a profile event; a message is not, and never loads.
    expect(result.freshness.newer_relevant_event_count).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('messages');
    // Every people/<collection> is reconciled by the same rules as positions,
    // so this is refused for the precise reason a position would be — there is
    // no observed CREATE to attach the update to — rather than dismissed as a
    // resource with no mapping at all. Snapshot rows carry no LinkedIn ids in
    // any collection, so matching it on school name would be a guess.
    expect(result.freshness.unresolved_changes[0]!.reason).toBe('unknown_resource_partial_update');
    expect(result.freshness.unresolved_changes[0]!.resource_name).toBe('people/educations');
    expect(result.freshness.unresolved_changes[0]!.detail).toContain('education e1');
  });

  it('rebuilds a certification from its own changelog events', async () => {
    // The gap this closes: people/certifications had no handler, so a member
    // who added a certificate saw it reported as "no deterministic profile
    // mapping" even though the changelog described it exactly.
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'cert-new',
            resourceName: 'people/certifications',
            resourceId: 'c1',
            method: 'CREATE',
            activity: { name: 'Crash Course on Python' },
            capturedAt: AFTER_T10,
          }),
          event({
            activityId: 'cert-edit',
            resourceName: 'people/certifications',
            resourceId: 'c1',
            method: 'PARTIAL_UPDATE',
            activity: { authority: 'Google' },
            capturedAt: AFTER_T10 + 60_000,
          }),
        ],
      }),
      { now: T11 },
    );

    expect(result.freshness.applied_overlay.map((c) => c.kind)).toEqual([
      'resource_created',
      'resource_updated',
    ]);
    // Rebuilt state, keyed by collection, merged across the two events.
    expect(result.freshness.event_derived.collections['certifications']).toEqual([
      { resource_id: 'c1', fields: { authority: 'Google', name: 'Crash Course on Python' } },
    ]);
    // Positions keep their own key and their own three kinds.
    expect(result.freshness.event_derived.positions).toEqual([]);
  });

  it('reads the profile even when the changelog step fails outright', async () => {
    const client: DmaSource & DmaChangelogSource = {
      assertDomainAllowed() {},
      async fetchSnapshotDomain(domain: string) {
        return { domain, rows: ROWS[domain] ?? [] };
      },
      async fetchChangelog() {
        throw new DomainError(
          'INTERNAL',
          'the member changelog did not terminate within 200 pages',
          {
            blockers: ['changelog_page_cap'],
          },
        );
      },
    };
    const result = await readLatestProfileFromDma(db, client, { now: T10 });

    // The two lanes are independent; a changelog that cannot be walked used to
    // make the profile unreadable even though the Snapshot lane was healthy.
    expect(result.observed['headline']).toBe('Full-Stack Web Developer');
    expect(result.changelog).toBeNull();
    expect(result.changelog_error).toContain('200 pages');
    // And without a reconciled changelog nothing may be called clean.
    expect(result.freshness.status).not.toBe('observed_no_newer_profile_event');
    expect(result.freshness.reasons.join(' ')).toContain('pending profile edits are unknown');
  });

  it('carries a section forward from an export-imported snapshot', async () => {
    db.run(
      `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
       VALUES ('src_export', 'linkedin_export', 'C:/export', 'Export', 'personal_doc', 'enabled', ?)`,
      T10.toISOString(),
    );
    db.run(
      `INSERT INTO linkedin_snapshots (id, source_kind, source_id, taken_at, imported_at, retention_class, version)
       VALUES ('snp_export', 'export_csv', 'src_export', ?, ?, 'durable_user', 1)`,
      T10.toISOString(),
      T10.toISOString(),
    );
    db.run(
      `INSERT INTO snapshot_fields (snapshot_id, field_key, value_text, char_count, raw_json)
       VALUES ('snp_export', 'education', 'Northgate State — BSc', 21, NULL)`,
    );

    // An export snapshot has no observation row, so the carry-forward lookup
    // used to miss it entirely and drop the section.
    const result = await readLatestProfileFromDma(
      db,
      harness({ rows: { ...ROWS, EDUCATION: [] } }),
      { now: T11 },
    );
    expect(result.observed['education']).toBe('Northgate State — BSc');
    expect(result.domains.find((d) => d.domain === 'EDUCATION')!.carried_forward_from).toBe(
      'snapshot:snp_export',
    );
    expect(result.freshness.status).toBe('partial_domain_fetch');
  });
});

describe('changelog overlay', () => {
  async function overlayOf(events: Array<Record<string, unknown>>) {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    return await readLatestProfileFromDma(db, harness({ events }), { now: T11 });
  }

  it('merges a position CREATE with a later PARTIAL_UPDATE by resource id', async () => {
    const result = await overlayOf([
      event({
        activityId: 'a1',
        resourceName: 'people/positions',
        resourceId: 'p1',
        method: 'CREATE',
        activity: { title: 'Web Developer', companyName: 'WES' },
        capturedAt: AFTER_T10,
      }),
      event({
        activityId: 'a2',
        resourceName: 'people/positions',
        resourceId: 'p1',
        method: 'PARTIAL_UPDATE',
        activity: { title: 'Senior Web Developer' },
        capturedAt: AFTER_T10 + 60_000,
      }),
    ]);

    expect(result.freshness.event_derived.positions).toEqual([
      { resource_id: 'p1', fields: { companyName: 'WES', title: 'Senior Web Developer' } },
    ]);
    expect(result.freshness.applied_overlay.map((c) => c.kind)).toEqual([
      'position_created',
      'position_updated',
    ]);
  });

  it('applies a DELETE only to a position it saw created', async () => {
    const result = await overlayOf([
      event({
        activityId: 'a1',
        resourceName: 'people/positions',
        resourceId: 'p1',
        method: 'CREATE',
        activity: { title: 'A' },
        capturedAt: AFTER_T10,
      }),
      event({
        activityId: 'a2',
        resourceName: 'people/positions',
        resourceId: 'p1',
        method: 'DELETE',
        capturedAt: AFTER_T10 + 1000,
      }),
      event({
        activityId: 'a3',
        resourceName: 'people/positions',
        resourceId: 'ghost',
        method: 'DELETE',
        capturedAt: AFTER_T10 + 2000,
      }),
    ]);

    expect(result.freshness.event_derived.positions).toEqual([]);
    expect(result.freshness.applied_overlay.map((c) => c.kind)).toEqual([
      'position_created',
      'position_deleted',
    ]);
    const unresolved = result.freshness.unresolved_changes;
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.reason).toBe('unknown_resource_delete');
    expect(unresolved[0]!.resource_id).toBe('ghost');
  });

  it('refuses to guess a partial update for a position it never saw created', async () => {
    const result = await overlayOf([
      event({
        activityId: 'a1',
        resourceName: 'people/positions',
        resourceId: 'unknown-id',
        method: 'PARTIAL_UPDATE',
        activity: { title: 'Head of Everything' },
      }),
    ]);

    expect(result.freshness.event_derived.positions).toEqual([]);
    expect(result.freshness.applied_overlay).toEqual([]);
    expect(result.freshness.unresolved_changes[0]!.reason).toBe('unknown_resource_partial_update');
    expect(result.freshness.status).toBe('upstream_snapshot_lag_detected');
    // The snapshot's own position rows carry no ids, so nothing was matched
    // against them by title.
    expect(result.observed['experience']).toContain('Vale Wind Power');
  });

  it('surfaces an empty activity and a processing failure rather than guessing', async () => {
    const result = await overlayOf([
      event({ activityId: 'a1', resourceName: 'people', method: 'PARTIAL_UPDATE', activity: {} }),
      event({
        activityId: 'a2',
        resourceName: 'people/positions',
        resourceId: 'p2',
        method: 'PARTIAL_UPDATE',
        activity: { title: 'x' },
        activityStatus: 'FAILURE',
      }),
    ]);

    const reasons = result.freshness.unresolved_changes.map((c) => c.reason).sort();
    expect(reasons).toEqual(['empty_activity', 'failed_processing']);
    expect(result.freshness.applied_overlay).toEqual([]);
  });

  it('lets a successful replay supersede an earlier failure while both rows remain', async () => {
    const result = await overlayOf([
      event({
        activityId: 'same-activity',
        resourceName: 'people/positions',
        resourceId: 'p3',
        method: 'CREATE',
        activity: { title: 'Attempt one' },
        activityStatus: 'FAILURE',
        capturedAt: AFTER_T10,
      }),
      event({
        activityId: 'same-activity',
        resourceName: 'people/positions',
        resourceId: 'p3',
        method: 'CREATE',
        activity: { title: 'Attempt one' },
        activityStatus: 'SUCCESSFUL_REPLAY',
        capturedAt: AFTER_T10,
        processedAt: AFTER_T10 + 120_000,
      }),
    ]);

    expect(result.freshness.event_derived.positions).toEqual([
      { resource_id: 'p3', fields: { title: 'Attempt one' } },
    ]);
    expect(result.freshness.unresolved_changes).toEqual([]);
    // Raw history is append-only: the failure record is still on disk.
    const statuses = db
      .all("SELECT activity_status FROM dma_changelog_events WHERE activity_id = 'same-activity'")
      .map((r) => String(r['activity_status']))
      .sort();
    expect(statuses).toEqual(['FAILURE', 'SUCCESSFUL_REPLAY']);
  });

  it('applies a headline partial update and reports an unmapped field by name only', async () => {
    const result = await overlayOf([
      event({
        activityId: 'a1',
        resourceName: 'people',
        method: 'PARTIAL_UPDATE',
        activity: {
          headline: { localized: { en_US: 'Staff Engineer', bg_BG: 'Старши инженер' } },
          headlineTimestamps: { lastModified: AFTER_T10 },
          someUndocumentedField: 'a value nobody should echo',
        },
      }),
    ]);

    // No caller locale and no preferredLocale in the payload, so the fallback
    // is the lexicographically first tag. That is deliberate: en_US is not
    // privileged, and a member whose profile is written in Bulgarian gets their
    // own text instead of an English one that happens to sort later.
    expect(result.freshness.event_derived.person).toEqual({ headline: 'Старши инженер' });
    expect(result.freshness.applied_overlay[0]!.field).toBe('headline');
    const unmapped = result.freshness.unresolved_changes.filter(
      (c) => c.reason === 'unmapped_person_field',
    );
    // The companion *Timestamps key is metadata about a field already applied.
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]!.detail).toContain('someUndocumentedField');
    expect(JSON.stringify(result)).not.toContain('a value nobody should echo');
  });

  it('honours a preferred locale without hardcoding en_US', async () => {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'a1',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: {
              headline: { localized: { en_US: 'Staff Engineer', bg_BG: 'Старши инженер' } },
            },
          }),
        ],
      }),
      { now: T11, locale: 'bg_BG' },
    );
    expect(result.freshness.event_derived.person['headline']).toBe('Старши инженер');
  });
});

describe('sensitive changelog activity', () => {
  it('never reaches profile output, in any field', async () => {
    const secret = 'PRIVATE-MESSAGE-BODY-DO-NOT-LEAK';
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'm1',
            resourceName: 'messages',
            resourceId: 'msg-1',
            method: 'CREATE',
            activity: { content: { string: secret } },
          }),
          event({
            activityId: 'i1',
            resourceName: 'invitations',
            resourceId: 'inv-1',
            method: 'CREATE',
            activity: { invitee: 'urn:li:person:someone-else' },
          }),
          event({
            activityId: 'a1',
            resourceName: 'people',
            method: 'PARTIAL_UPDATE',
            activity: { headline: 'Staff Engineer' },
          }),
        ],
      }),
      { now: T11 },
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('messages');
    expect(serialized).not.toContain('invitations');
    expect(serialized).not.toContain('someone-else');
    // The events themselves are still archived — they just never enter the
    // profile path.
    expect(
      db.all("SELECT 1 FROM dma_changelog_events WHERE resource_name = 'messages'"),
    ).toHaveLength(1);
    // Only the profile event is counted as relevant.
    expect(result.freshness.newer_relevant_event_count).toBe(1);
    // And no audit payload carries them either.
    expect(JSON.stringify(db.all('SELECT payload_json FROM audit_events'))).not.toContain(secret);
  });
});

describe('MCP contract', () => {
  function readLatestTool() {
    const tools = toolDefs({ db, fts5: false, home: dir, actor: 'mcp_host' });
    return tools.find((t) => t.name === 'linkedin_profile_read_latest')!;
  }

  it('is registered with accurate annotations for a live, persisting read', () => {
    const tool = readLatestTool();
    expect(tool).toBeDefined();
    expect(tool.permission).toBe('external-read');
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tool.description).toContain('not_guaranteed');
    // And the local tool no longer reads like a live one.
    const get = toolDefs({ db, fts5: false, home: dir, actor: 'mcp_host' }).find(
      (t) => t.name === 'linkedin_profile_get',
    )!;
    expect(get.description).toContain('LOCAL canonical profile');
    expect(get.annotations.readOnlyHint).toBe(true);
  });

  it('has an input schema the dashboard can render and an output schema that matches runtime', async () => {
    const tool = readLatestTool();
    expect(() => z.toJSONSchema(tool.inputSchema)).not.toThrow();

    const result = await readLatestProfileFromDma(
      db,
      harness({
        events: [
          event({
            activityId: 'a1',
            resourceName: 'people/positions',
            resourceId: 'p1',
            method: 'CREATE',
            activity: { title: 'x' },
          }),
          event({
            activityId: 'a2',
            resourceName: 'people/positions',
            resourceId: 'ghost',
            method: 'DELETE',
          }),
        ],
      }),
      { now: T12 },
    );
    const payload = {
      observed: result.observed,
      snapshot_id: result.snapshot_id,
      observation: result.observation,
      domains: result.domains,
      changelog: result.changelog,
      changelog_error: result.changelog_error,
      freshness: result.freshness,
    };
    const parsed = tool.outputSchema.safeParse(payload);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});

// The overlay's refusals.
//
// An event the mapper cannot apply deterministically is recorded as unresolved
// rather than guessed at. That distinction is the whole basis for calling a
// profile "stale but explained" instead of just stale: the member can see
// exactly which edits are pending and which the tool declined to interpret.
describe('changelog events the overlay will not guess at', () => {
  async function overlay(events: Array<Record<string, unknown>>) {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    return await readLatestProfileFromDma(db, harness({ events }), { now: T11 });
  }

  const reasons = (result: Awaited<ReturnType<typeof overlay>>) =>
    result.freshness.unresolved_changes.map((u) => u.reason);

  it('records an event with no resource id rather than applying it to something', async () => {
    const result = await overlay([
      event({
        activityId: 'no-id',
        resourceName: 'people/positions',
        resourceId: null,
        method: 'PARTIAL_UPDATE',
        activity: { title: 'Senior Web Developer' },
      }),
    ]);

    // Without an id there is nothing to say this edit is about.
    expect(reasons(result)).toContain('missing_resource_id');
  });

  it('establishes a position from an empty CREATE, and says the payload was empty', async () => {
    const result = await overlay([
      event({
        activityId: 'empty-create',
        resourceName: 'people/positions',
        resourceId: 'p-empty',
        method: 'CREATE',
      }),
    ]);

    // "A position with this id exists" is stated outright by the event, so the
    // key is established — that is what lets a later update resolve instead of
    // dangling. The missing payload is reported separately.
    expect(reasons(result)).toContain('empty_activity');
    expect(result.freshness.applied_overlay.some((c) => /created/i.test(JSON.stringify(c)))).toBe(
      true,
    );
  });

  it('refuses a position method it has no mapping for', async () => {
    const result = await overlay([
      event({
        activityId: 'weird',
        resourceName: 'people/positions',
        resourceId: 'p1',
        method: 'MERGE',
        activity: { title: 'Something' },
      }),
    ]);

    expect(reasons(result)).toContain('unsupported_resource_or_version');
  });

  it('never applies a DELETE on the person themselves', async () => {
    const result = await overlay([
      event({
        activityId: 'person-delete',
        resourceName: 'people',
        resourceId: 'urn:li:person:abc',
        method: 'DELETE',
        activity: {},
      }),
    ]);

    // A changelog event must not be able to blank a member's profile in the
    // local overlay; only a snapshot can say the profile is empty.
    expect(reasons(result)).toContain('unsupported_resource_or_version');
  });

  it('records a person event that carried no fields', async () => {
    const result = await overlay([
      event({
        activityId: 'person-empty',
        resourceName: 'people',
        resourceId: 'urn:li:person:abc',
        method: 'PARTIAL_UPDATE',
      }),
    ]);

    expect(reasons(result)).toContain('empty_activity');
  });

  it('refuses a person method it has no mapping for', async () => {
    const result = await overlay([
      event({
        activityId: 'person-weird',
        resourceName: 'people',
        resourceId: 'urn:li:person:abc',
        method: 'BATCH_UPDATE',
        activity: { headline: 'Something' },
      }),
    ]);

    expect(reasons(result)).toContain('unsupported_resource_or_version');
  });

  it('lets a full UPDATE clear a field an earlier event set', async () => {
    const result = await overlay([
      event({
        activityId: 'p-set',
        resourceName: 'people',
        resourceId: 'urn:li:person:abc',
        method: 'PARTIAL_UPDATE',
        activity: { headline: 'Full-Stack Web Developer', summary: 'Builds things.' },
        capturedAt: AFTER_T10,
      }),
      event({
        activityId: 'p-replace',
        resourceName: 'people',
        resourceId: 'urn:li:person:abc',
        method: 'UPDATE',
        activity: { headline: 'Full-Stack Web Developer' },
        capturedAt: AFTER_T10 + 60_000,
      }),
    ]);

    // A full UPDATE replaces the person. A field the member cleared must not
    // survive from an earlier event, or the overlay reports text that is no
    // longer on the profile.
    const person = result.freshness.event_derived.person;
    expect(person['headline']).toBe('Full-Stack Web Developer');
    expect(person['summary'] ?? null).toBeNull();
  });

  it('deletes a position the member removed', async () => {
    const result = await overlay([
      event({
        activityId: 'p-create',
        resourceName: 'people/positions',
        resourceId: 'p-gone',
        method: 'CREATE',
        activity: { title: 'Web Developer', companyName: 'Vale Wind Power' },
        capturedAt: AFTER_T10,
      }),
      event({
        activityId: 'p-delete',
        resourceName: 'people/positions',
        resourceId: 'p-gone',
        method: 'DELETE',
        capturedAt: AFTER_T10 + 60_000,
      }),
    ]);

    expect(result.freshness.applied_overlay.some((c) => /deleted/i.test(JSON.stringify(c)))).toBe(
      true,
    );
    expect(result.freshness.event_derived.positions.some((p) => p.resource_id === 'p-gone')).toBe(
      false,
    );
  });
});

// Three more shapes the overlay declines, each for a different reason.
//
// The value of the unresolved list is that it is specific. "Something could not
// be applied" is not actionable; "the resource path is nested deeper than this
// build knows how to key on" tells a member the tool is behind LinkedIn rather
// than that their edit was lost.
describe('changelog shapes the overlay declines for a stated reason', () => {
  async function overlay(events: Array<Record<string, unknown>>) {
    await readLatestProfileFromDma(db, harness({}), { now: T10 });
    return await readLatestProfileFromDma(db, harness({ events }), { now: T11 });
  }

  // Unresolved changes deliberately carry no activity id and no activity
  // value, so they are found by the resource they are about.
  const pick = (
    result: Awaited<ReturnType<typeof overlay>>,
    match: (u: { resource_name: string | null; resource_id: string | null }) => boolean,
  ) => result.freshness.unresolved_changes.find(match);

  it('declines a resource path nested deeper than a collection', async () => {
    const result = await overlay([
      event({
        activityId: 'nested',
        resourceName: 'people/positions/highlights',
        resourceId: 'p-1',
        method: 'PARTIAL_UPDATE',
        activity: { title: 'Senior Web Developer' },
      }),
    ]);

    // Keying `positions/highlights` as though it were a collection would file
    // the edit against a resource that does not exist in this model.
    const found = pick(result, (u) => u.resource_name === 'people/positions/highlights');
    expect(found?.reason).toBe('unsupported_resource_or_version');
    expect(found?.detail).toMatch(/no deterministic profile mapping/i);
  });

  it('declines an update to an established position that carried no fields', async () => {
    const result = await overlay([
      event({
        activityId: 'p-create',
        resourceName: 'people/positions',
        resourceId: 'p-2',
        method: 'CREATE',
        activity: { title: 'Web Developer', companyName: 'Vale Wind Power' },
        capturedAt: AFTER_T10,
      }),
      event({
        activityId: 'p-blank',
        resourceName: 'people/positions',
        resourceId: 'p-2',
        method: 'UPDATE',
        capturedAt: AFTER_T10 + 60_000,
      }),
    ]);

    // An UPDATE is a full replacement. Applying an empty one would blank the
    // position the CREATE established, on no evidence that the member did.
    expect(pick(result, (u) => u.resource_id === 'p-2')?.reason).toBe('empty_activity');
    expect(result.freshness.event_derived.positions.some((p) => p.resource_id === 'p-2')).toBe(
      true,
    );
  });

  it('declines a mapped person field whose value is blank', async () => {
    const result = await overlay([
      event({
        activityId: 'blank-headline',
        resourceName: 'people',
        resourceId: null,
        method: 'PARTIAL_UPDATE',
        activity: { headline: '   ' },
      }),
    ]);

    // The key is one this build knows; the value is not usable. Treating
    // whitespace as a headline would overwrite the real one with nothing.
    const found = pick(result, (u) => u.resource_name === 'people');
    expect(found?.reason).toBe('unmapped_person_field');
    expect(found?.detail).toMatch(/no usable value/i);
  });
});
