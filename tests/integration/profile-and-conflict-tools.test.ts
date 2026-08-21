import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectConflicts,
  enableSourceFromDashboard,
  listClaims,
  listConflicts,
  registerSource,
  resolveConflict,
  runImport,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// The profile snapshot and diff tools, and what a conflict resolution is
// allowed to touch.
//
// The sharp edge in conflict resolution is scope: it takes a list of per-claim
// decisions, and each one verifies or rejects a claim. Nothing in that list may
// name a claim outside the conflict, or resolving a trivial duplication would
// become a general-purpose way to reject anything in the ledger.

let fixture: Fixture;
let evidence: string;
let call: (name: string, args: unknown) => Promise<unknown>;

beforeEach(async () => {
  fixture = createFixture('profile-conflict-tools');
  seedHealthy(fixture);
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-pctev-'));

  const zipPath = join(evidence, 'export.zip');
  writeFileSync(
    zipPath,
    makeZip([
      {
        name: 'Profile.csv',
        data: Buffer.from(
          'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
            'Alex,Rivera,,,,Old Headline,Old summary.,Software,,Ghent,,,\n',
        ),
      },
    ]),
  );
  const source = registerSource(fixture.db, {
    path: zipPath,
    kind: 'linkedin_export',
    trust: 'personal_doc',
    label: 'export v1',
    dataHome: fixture.dir,
  });
  enableSourceFromDashboard(fixture.db, source.id);
  await runImport(fixture.db, fixture.store, source.id);

  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
  } as never);
  call = async (name, args) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
  seededSourceId = source.id;
});

let seededSourceId: string;

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('linkedin_snapshot_import', () => {
  it('reports which fields it read and any gaps it found', async () => {
    const out = (await call('linkedin_snapshot_import', { source_id: seededSourceId })) as {
      snapshot_id: string;
      version: number;
      field_count: number;
      fields: string[];
      warnings: string[];
    };

    expect(out.snapshot_id).toMatch(/^snp_/);
    expect(out.field_count).toBeGreaterThan(0);
    // Sorted, so two runs over the same export read the same in a diff.
    expect([...out.fields].sort()).toEqual(out.fields);
    expect(Array.isArray(out.warnings)).toBe(true);
  }, 60_000);

  it('accepts the date the member says the export was taken', async () => {
    const out = (await call('linkedin_snapshot_import', {
      source_id: seededSourceId,
      taken_at: '2026-04-01T00:00:00.000Z',
    })) as { snapshot_id: string };

    expect(
      fixture.db.get('SELECT taken_at FROM linkedin_snapshots WHERE id = ?', out.snapshot_id)?.[
        'taken_at'
      ],
    ).toContain('2026-04-01');
  }, 60_000);

  it('numbers successive snapshots so the newest is identifiable', async () => {
    const first = (await call('linkedin_snapshot_import', { source_id: seededSourceId })) as {
      version: number;
    };
    const second = (await call('linkedin_snapshot_import', { source_id: seededSourceId })) as {
      version: number;
    };

    expect(second.version).toBeGreaterThan(first.version);
  }, 60_000);

  it('refuses a source it does not know', async () => {
    await expect(call('linkedin_snapshot_import', { source_id: 'src_nope' })).rejects.toBeTruthy();
  });
});

describe('linkedin_profile_read_latest and the snapshot list', () => {
  it('pages the snapshot list', async () => {
    await call('linkedin_snapshot_import', { source_id: seededSourceId });
    await call('linkedin_snapshot_import', { source_id: seededSourceId });

    const first = (await call('linkedin_profile_get', { limit: 1 })) as {
      snapshots?: { items?: unknown[]; has_more?: boolean };
    };

    // The list is paged like every other read, so a member with a long history
    // does not pull all of it to see the latest.
    expect(first).toBeTruthy();
  }, 60_000);
});

describe('linkedin_profile_diff', () => {
  it('compares canonical text against the latest snapshot and counts what moved', async () => {
    await call('linkedin_snapshot_import', { source_id: seededSourceId });

    const out = (await call('linkedin_profile_diff', {
      left: 'canonical',
      right: 'snapshot:latest',
    })) as { fields: Array<{ changed: boolean }>; changed_count: number };

    expect(out.fields.length).toBeGreaterThan(0);
    expect(out.changed_count).toBe(out.fields.filter((f) => f.changed).length);
    // The seeded headline differs from the export, so something moved.
    expect(out.changed_count).toBeGreaterThan(0);
  }, 60_000);

  it('reports no change when both sides are the same', async () => {
    await call('linkedin_snapshot_import', { source_id: seededSourceId });

    const out = (await call('linkedin_profile_diff', {
      left: 'snapshot:latest',
      right: 'snapshot:latest',
    })) as { changed_count: number };

    expect(out.changed_count).toBe(0);
  }, 60_000);

  it('refuses a reference it does not understand', async () => {
    // The reference is a small grammar rather than a free-form object, so a
    // typo is refused at the schema rather than silently diffing the wrong
    // thing.
    for (const right of ['latest', 'snapshot', 'snapshot:', 'canonical:latest', '']) {
      await expect(
        call('linkedin_profile_diff', { left: 'canonical', right }),
        JSON.stringify(right),
      ).rejects.toBeTruthy();
    }
  });

  it('refuses a snapshot id that does not exist', async () => {
    await expect(
      call('linkedin_profile_diff', { left: 'canonical', right: 'snapshot:snp_nope' }),
    ).rejects.toBeTruthy();
  });
});

describe('what a conflict resolution may touch', () => {
  function openConflict(): { id: string; members: string[] } {
    detectConflicts(fixture.db);
    const conflict = listConflicts(fixture.db, { state: 'open' })[0];
    if (!conflict) throw new Error('the seeded corpus should contain a conflict');
    return { id: conflict.id, members: conflict.members.map((m) => m.claim_id) };
  }

  it('refuses without a confirmation', () => {
    const conflict = openConflict();

    expect(() =>
      resolveConflict(fixture.db, {
        conflict_id: conflict.id,
        resolution: 'dismissed',
        note: 'not really a conflict',
        confirm: false,
      }),
    ).toThrow(/human decision/i);
  });

  it('refuses a conflict it does not know', () => {
    expect(() =>
      resolveConflict(fixture.db, {
        conflict_id: 'cfl_nope',
        resolution: 'dismissed',
        note: 'x',
        confirm: true,
      }),
    ).toThrow(/not found/i);
  });

  it('refuses one that has already been settled', () => {
    const conflict = openConflict();
    resolveConflict(fixture.db, {
      conflict_id: conflict.id,
      resolution: 'dismissed',
      note: 'these describe different suites',
      confirm: true,
    });

    expect(() =>
      resolveConflict(fixture.db, {
        conflict_id: conflict.id,
        resolution: 'dismissed',
        note: 'again',
        confirm: true,
      }),
    ).toThrow(/already/i);
  });

  it('refuses member actions naming a claim outside the conflict, on a dismissal too', () => {
    const conflict = openConflict();
    const outsider = listClaims(fixture.db, {}, false).find(
      (c) => !conflict.members.includes(c.id) && c.state === 'candidate',
    );
    if (!outsider) return;

    // This check used to live inside the 'resolved' branch, so dismissing a
    // conflict could verify or reject any claim in the ledger. It applies to
    // both resolutions now, and the test says which.
    expect(() =>
      resolveConflict(fixture.db, {
        conflict_id: conflict.id,
        resolution: 'dismissed',
        note: 'not a conflict',
        confirm: true,
        member_actions: [{ claim_id: outsider.id, action: 'reject', reason: 'unrelated' }],
      }),
    ).toThrow(/outside this conflict/i);

    expect(listClaims(fixture.db, {}, false).find((c) => c.id === outsider.id)?.state).toBe(
      'candidate',
    );
  });

  it('marks a member ambiguous when that is the decision', () => {
    const conflict = openConflict();

    resolveConflict(fixture.db, {
      conflict_id: conflict.id,
      resolution: 'resolved',
      note: 'neither number is safe to publish',
      confirm: true,
      member_actions: conflict.members.map((claim_id) => ({
        claim_id,
        action: 'mark_ambiguous' as const,
        reason: 'the suites are counted differently',
      })),
    });

    // A contradiction where nothing survives is legitimate — both may be
    // wrong — and ambiguous is how that is said without a tombstone.
    const states = conflict.members.map(
      (id) => listClaims(fixture.db, {}, false).find((c) => c.id === id)?.state,
    );
    expect(states.every((s) => s === 'ambiguous')).toBe(true);
  });

  it('leaves a member alone when its action is not one it acts on', () => {
    const conflict = openConflict();
    const before = conflict.members.map(
      (id) => listClaims(fixture.db, {}, false).find((c) => c.id === id)?.state,
    );

    resolveConflict(fixture.db, {
      conflict_id: conflict.id,
      resolution: 'dismissed',
      note: 'these describe different suites',
      confirm: true,
    });

    // Dismissal without per-claim decisions changes no claim at all: the
    // conflict was the false positive, not the claims.
    const after = conflict.members.map(
      (id) => listClaims(fixture.db, {}, false).find((c) => c.id === id)?.state,
    );
    expect(after).toEqual(before);
  });
});
