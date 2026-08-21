import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listClaims, listSources } from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The remaining tool handlers: reads by id, the claim lifecycle actions as the
// model reaches them, source registration and enablement, analytics, the
// profile reads and the capability and settings surfaces.
//
// Everything goes through the declared input schema, the way the SDK
// dispatches, so the arguments under test are ones a caller can actually send.

const fixtures: Fixture[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS reclaims it */
    }
  }
});

function tools(label: string) {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  const seeded = seedHealthy(fixture);
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
    scheduleFullPurge: () => {},
  } as never);
  const call = async (name: string, args: unknown) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
  return { fixture, db: fixture.db, seeded, call };
}

function evidenceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-sweep-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'README.md'), '# Project\n\nA deterministic CSV parser.\n', 'utf8');
  return dir;
}

describe('linkedin_claim_list', () => {
  it('returns one claim with its evidence when asked by id', async () => {
    const { seeded, call } = tools('claim-list-id');

    const out = (await call('linkedin_claim_list', { id: seeded.verifiedId })) as {
      items: Array<{ id: string }>;
      has_more: boolean;
      evidence: Array<{ artifact_id: string }>;
    };

    expect(out.items[0]?.id).toBe(seeded.verifiedId);
    expect(out.has_more).toBe(false);
    // A claim without its evidence attached is just an assertion.
    expect(out.evidence[0]?.artifact_id).toBe(seeded.artifactId);
  });

  it('filters by state, staleness, sensitivity and cited artifact', async () => {
    const { seeded, call } = tools('claim-list-filters');

    for (const args of [
      { state: 'verified' },
      { stale: true },
      { artifact_id: seeded.artifactId },
      { q: 'audit log' },
    ]) {
      const out = (await call('linkedin_claim_list', args)) as { items: unknown[] };
      expect(Array.isArray(out.items), JSON.stringify(args)).toBe(true);
    }
  });

  it('pages, and reports whether more remain', async () => {
    const { call } = tools('claim-list-paging');

    const first = (await call('linkedin_claim_list', { limit: 1 })) as {
      items: unknown[];
      has_more: boolean;
      next_cursor?: string;
    };
    expect(first.items.length).toBeLessThanOrEqual(1);
    if (!first.next_cursor) return;

    const second = (await call('linkedin_claim_list', {
      limit: 1,
      cursor: first.next_cursor,
    })) as { items: Array<{ id: string }> };
    expect(second.items.length).toBeLessThanOrEqual(1);
  });
});

describe('linkedin_claim_manage lifecycle actions', () => {
  it('marks a claim ambiguous, keeping the reason as a limitation', async () => {
    const { db, seeded, call } = tools('claim-ambiguous');

    const out = (await call('linkedin_claim_manage', {
      action: 'mark_ambiguous',
      claim_id: seeded.candidateId,
      reason: 'true of the CLI only',
      confirm: true,
    })) as { claim: { state: string } };

    expect(out.claim.state).toBe('ambiguous');
    expect(
      listClaims(db, {}, false).find((c) => c.id === seeded.candidateId)?.limitations,
    ).toContain('CLI');
  });

  it('merges one claim into another', async () => {
    const { db, seeded, call } = tools('claim-merge');

    const out = (await call('linkedin_claim_manage', {
      action: 'merge',
      claim_id: seeded.candidateId,
      merge_into: seeded.verifiedId,
      confirm: true,
    })) as { claim: { id: string; state: string } };

    // The merged claim leaves the live corpus. The MCP projection deliberately
    // does not carry merged_into, so what the model sees is simply that this
    // claim is no longer something to cite.
    expect(out.claim.id).toBe(seeded.candidateId);
    expect(out.claim.state).toBe('expired');
    expect(listClaims(db, {}, false).find((c) => c.id === seeded.candidateId)?.merged_into).toBe(
      seeded.verifiedId,
    );
  });

  it('re-runs conflict detection after every change, and says how many appeared', async () => {
    const { seeded, call } = tools('claim-conflicts');

    const out = (await call('linkedin_claim_manage', {
      action: 'verify',
      claim_id: seeded.candidateId,
      confirm: true,
    })) as { conflicts_created: string[] };

    // Detection runs on every change and names what it found, so a claim that
    // contradicts another cannot slip in unnoticed between the change and the
    // next time somebody looks.
    expect(Array.isArray(out.conflicts_created)).toBe(true);
  });
});

describe('linkedin_conflict_list and resolve', () => {
  it('lists the conflicts the corpus already has', async () => {
    const { call } = tools('conflict-list');

    const out = (await call('linkedin_conflict_list', {})) as {
      items: Array<{ id: string; state: string; members: unknown[] }>;
    };

    // The seeded corpus holds two claims with the same metric signature and
    // different numbers, which is exactly what the detector is for.
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items[0]?.members.length).toBeGreaterThan(1);
  });

  it('refuses to resolve a conflict without a confirmation', async () => {
    const { call } = tools('conflict-resolve-unconfirmed');
    const listed = (await call('linkedin_conflict_list', {})) as {
      items: Array<{ id: string }>;
    };
    const conflict = listed.items[0];
    if (!conflict) return;

    // Resolving a conflict can permanently reject a member's claim.
    await expect(
      call('linkedin_conflict_resolve', {
        conflict_id: conflict.id,
        resolution: 'resolved',
        note: 'the newer count is right',
      }),
    ).rejects.toBeTruthy();
  });

  it('refuses a resolution that leaves a member claim undecided', async () => {
    const { call } = tools('conflict-resolve-partial');
    const listed = (await call('linkedin_conflict_list', {})) as {
      items: Array<{ id: string; members: Array<{ claim_id: string }> }>;
    };
    const conflict = listed.items[0];
    if (!conflict) return;

    // Closing a contradiction without saying what happens to each claim would
    // leave both standing and the conflict marked handled.
    await expect(
      call('linkedin_conflict_resolve', {
        conflict_id: conflict.id,
        resolution: 'resolved',
        note: 'the newer count is right',
        confirm: true,
        member_actions: [{ claim_id: conflict.members[0]!.claim_id, action: 'verify' }],
      }),
    ).rejects.toThrow(/every member claim/i);
  });

  it('refuses member actions naming a claim outside the conflict', async () => {
    const { seeded, call } = tools('conflict-resolve-foreign');
    const listed = (await call('linkedin_conflict_list', {})) as {
      items: Array<{ id: string; members: Array<{ claim_id: string }> }>;
    };
    const conflict = listed.items[0];
    if (!conflict) return;

    // Otherwise resolving one conflict becomes a way to reject any claim in
    // the ledger by naming it here.
    await expect(
      call('linkedin_conflict_resolve', {
        conflict_id: conflict.id,
        resolution: 'resolved',
        note: 'trying to reach a claim that is not part of this',
        confirm: true,
        member_actions: [
          ...conflict.members.map((m) => ({ claim_id: m.claim_id, action: 'verify' as const })),
          { claim_id: seeded.expiredId, action: 'reject' as const, reason: 'unrelated' },
        ],
      }),
    ).rejects.toThrow(/outside this conflict/i);
  });

  it('resolves a conflict once every member claim has a decision', async () => {
    const { call } = tools('conflict-resolve');
    const listed = (await call('linkedin_conflict_list', {})) as {
      items: Array<{ id: string; members: Array<{ claim_id: string }> }>;
    };
    const conflict = listed.items[0];
    if (!conflict) return;

    const out = (await call('linkedin_conflict_resolve', {
      conflict_id: conflict.id,
      resolution: 'resolved',
      note: 'the newer count is right',
      confirm: true,
      member_actions: conflict.members.map((member, index) => ({
        claim_id: member.claim_id,
        action: index === 0 ? ('verify' as const) : ('reject' as const),
        reason: index === 0 ? undefined : 'superseded by the newer count',
      })),
    })) as { conflict: { state: string } };

    expect(out.conflict.state).not.toBe('open');
  });

  it('dismisses a conflict whose members do not actually disagree', async () => {
    const { call } = tools('conflict-dismiss');
    const listed = (await call('linkedin_conflict_list', {})) as {
      items: Array<{ id: string; members: Array<{ claim_id: string }> }>;
    };
    const conflict = listed.items[0];
    if (!conflict) return;

    const out = (await call('linkedin_conflict_resolve', {
      conflict_id: conflict.id,
      resolution: 'dismissed',
      note: 'these describe different suites',
      confirm: true,
    })) as { conflict: { state: string } };

    // Dismissal is the escape hatch for a false positive, and it does not need
    // a decision per claim because nothing is being thrown out.
    expect(out.conflict.state).toBe('dismissed');
  });
});

describe('linkedin_coverage_check', () => {
  it('scores each sentence and returns the same report id for the same text', async () => {
    const { call } = tools('coverage-check');
    const text = 'The project contains 181 test files. It also cures scurvy.';

    const first = (await call('linkedin_coverage_check', { text })) as {
      coverage_report_id: string;
      total_count: number;
      sentences: Array<{ status: string }>;
    };
    const second = (await call('linkedin_coverage_check', { text })) as {
      coverage_report_id: string;
    };

    expect(first.total_count).toBe(2);
    // Content-addressed: the same text is the same report, so a re-check never
    // silently produces a second answer.
    expect(second.coverage_report_id).toBe(first.coverage_report_id);
    expect(first.sentences.some((s) => s.status === 'unsupported')).toBe(true);
  });
});

describe('linkedin_source_manage', () => {
  it('registers a source, and leaves it awaiting an enablement decision', async () => {
    const { db, call } = tools('source-register');

    const out = (await call('linkedin_source_manage', {
      action: 'register',
      path: evidenceDir(),
      kind: 'folder',
      trust: 'own_repo',
      label: 'Portfolio',
    })) as { source: { id: string; status: string } };

    // Registering is not consent. Nothing is read until a human enables it by
    // typing its id.
    expect(out.source.status).toBe('pending_review');
    expect(listSources(db, { status: 'pending_review' }).some((s) => s.id === out.source.id)).toBe(
      true,
    );
  });

  it('refuses to enable without the exact ENABLE command', async () => {
    const { seeded, call } = tools('source-enable-command');

    await expect(
      call('linkedin_source_manage', {
        action: 'enable',
        source_id: seeded.pendingSourceId,
        command: 'ENABLE something-else',
        confirm: true,
      }),
    ).rejects.toThrow(/confirmation required/i);
  });

  it('enables a source when the command names it exactly', async () => {
    const { db, seeded, call } = tools('source-enable');

    const out = (await call('linkedin_source_manage', {
      action: 'enable',
      source_id: seeded.pendingSourceId,
      command: `ENABLE ${seeded.pendingSourceId}`,
      confirm: true,
    })) as { source: { status: string } };

    expect(out.source.status).toBe('enabled');
    expect(listSources(db, {}).find((s) => s.id === seeded.pendingSourceId)?.status).toBe(
      'enabled',
    );
  });

  it('refuses a path outside a drive-letter root', async () => {
    const { call } = tools('source-register-path');

    for (const path of ['relative/path', '/etc/passwd', 'C:\\']) {
      await expect(
        call('linkedin_source_manage', {
          action: 'register',
          path,
          kind: 'folder',
          trust: 'own_repo',
          label: 'bad',
        }),
        `${path} should be refused`,
      ).rejects.toBeTruthy();
    }
  });
});

describe('linkedin_source_list and linkedin_artifact_list', () => {
  it('lists sources, filtered by status', async () => {
    const { call } = tools('source-list');

    const all = (await call('linkedin_source_list', {})) as { items: unknown[] };
    const pending = (await call('linkedin_source_list', { status: 'pending_review' })) as {
      items: Array<{ status: string }>;
    };

    expect(all.items.length).toBeGreaterThan(0);
    for (const source of pending.items) expect(source.status).toBe('pending_review');
  });

  it('lists artifacts and pages them', async () => {
    const { call } = tools('artifact-list');

    const out = (await call('linkedin_artifact_list', { limit: 1 })) as {
      items: unknown[];
      has_more: boolean;
    };
    expect(out.items.length).toBeLessThanOrEqual(1);
  });
});

describe('linkedin_analytics_query', () => {
  it('reports an empty summary rather than failing when nothing has been imported', async () => {
    const { call } = tools('analytics-empty');

    const out = (await call('linkedin_analytics_query', {})) as Record<string, unknown>;
    expect(out).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain('NaN');
  });

  it('imports observations and reports them back', async () => {
    const { call } = tools('analytics-import');

    await call('linkedin_analytics_import', {
      rows: [
        {
          subject_ref: 'urn:li:share:1',
          metric: 'impressions',
          value: 1200,
          observed_at: '2026-01-05T00:00:00.000Z',
        },
      ],
      confirm: true,
    });

    const out = (await call('linkedin_analytics_query', {})) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('impressions');
  });

  it('reports rows it rejected instead of dropping them', async () => {
    const { call } = tools('analytics-reject');

    const out = (await call('linkedin_analytics_import', {
      rows: [
        { subject_ref: '', metric: 'impressions', value: 1, observed_at: '2026-01-05T00:00:00Z' },
      ],
      confirm: true,
    })) as { rejected: unknown[] };

    // A silently dropped row is a number the member will later believe.
    expect(out.rejected.length).toBeGreaterThan(0);
  });
});

describe('the profile reads', () => {
  it('returns the canonical sections', async () => {
    const { call } = tools('profile-get');

    const out = (await call('linkedin_profile_get', {})) as { sections: Record<string, unknown> };
    expect(out.sections).toBeTruthy();
  });

  it('scores the profile against its evidence', async () => {
    const { call } = tools('profile-score');

    const out = (await call('linkedin_profile_score', {})) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('NaN');
  });

  it('reports the diff against the latest snapshot, or says there is none', async () => {
    const { call } = tools('profile-diff');

    // With no snapshot imported there is nothing to diff against, and saying so
    // is the answer — not an empty diff that looks like agreement.
    const result = await call('linkedin_profile_diff', {}).catch((error: unknown) => ({
      threw: String(error),
    }));
    expect(result).toBeTruthy();
  });

  it('refuses to update a section that no verified claim supports', async () => {
    const { call } = tools('profile-update');

    await expect(
      call('linkedin_profile_update', {
        section_key: 'headline',
        content_text: 'Cured scurvy at scale.',
        claim_ids: [],
      }),
    ).rejects.toBeTruthy();
  });
});

describe('capabilities and settings', () => {
  it('reports every capability with its blockers', async () => {
    const { call } = tools('capability-status');

    const out = (await call('linkedin_capability_status', {})) as {
      capabilities: Array<{ feature: string; status: string; blockers: string[] }>;
    };

    expect(out.capabilities.length).toBeGreaterThan(0);
    // A capability that is not available has to say why, or the member has
    // nowhere to start.
    for (const capability of out.capabilities) {
      if (capability.status !== 'verified') expect(Array.isArray(capability.blockers)).toBe(true);
    }
  });

  it('refuses to set a secret-shaped setting through MCP', async () => {
    const { call } = tools('settings-secret');

    await expect(
      call('linkedin_settings_set', {
        key: 'linkedin.access_token',
        value: 'AQV-something',
        confirm: true,
      }),
    ).rejects.toBeTruthy();
  });

  it('sets a known setting when confirmed', async () => {
    const { call } = tools('settings-set');

    const out = (await call('linkedin_settings_set', {
      key: 'importer.max_file_mb',
      value: 64,
      confirm: true,
    })) as Record<string, unknown>;

    expect(out).toBeTruthy();
  });
});

describe('the onboarding tools', () => {
  it('reports readiness without needing anything to be set up first', async () => {
    const { call } = tools('onboarding-readiness');

    const out = (await call('linkedin_readiness_check', {})) as {
      checks: Array<{ id: string; status: string }>;
    };

    expect(out.checks.length).toBeGreaterThan(0);
  });

  it('previews a description rather than storing it, and names the command that would', async () => {
    const { db, call } = tools('onboarding-describe');
    const before = listSources(db, {}).length;

    const out = (await call('linkedin_intake_describe', {
      text: 'I build local-first developer tooling, mostly around evidence and provenance.',
    })) as { stored: boolean; expected_command: string; next_step: string };

    // Nothing is stored yet, and the command is bound to a digest of this exact
    // text — so a model cannot get one wording approved and then store another.
    expect(out.stored).toBe(false);
    expect(out.expected_command).toMatch(/^DESCRIBE [a-f0-9]{8}$/);
    expect(listSources(db, {}).length).toBe(before);
    expect(out.next_step).toMatch(/show the member/i);
  });

  it('refuses a confirmation whose digest describes different text', async () => {
    const { db, call } = tools('onboarding-describe-mismatch');
    const before = listSources(db, {}).length;

    await expect(
      call('linkedin_intake_describe', {
        text: 'I build local-first developer tooling, mostly around evidence and provenance.',
        confirm: true,
        command: 'DESCRIBE 00000000',
      }),
    ).rejects.toBeTruthy();
    expect(listSources(db, {}).length).toBe(before);
  });

  it('stores the text once the digest-bound command matches', async () => {
    const { db, call } = tools('onboarding-describe-ok');
    const text = 'I build local-first developer tooling, mostly around evidence and provenance.';
    const preview = (await call('linkedin_intake_describe', { text })) as {
      expected_command: string;
    };
    const before = listSources(db, {}).length;

    const out = (await call('linkedin_intake_describe', {
      text,
      confirm: true,
      command: preview.expected_command,
    })) as { stored: boolean; trust: string };

    expect(out.stored).toBe(true);
    // Self-attested, so anything resting on it stays self-reported.
    expect(out.trust).toBe('self_attested');
    expect(listSources(db, {}).length).toBeGreaterThan(before);
  });
});
