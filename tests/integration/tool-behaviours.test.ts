import { afterEach, describe, expect, it } from 'vitest';
import { listClaims, listDrafts, writeDraft } from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The decision paths inside the tools, as opposed to the registry properties
// the surface sweep covers. Almost everything here is a refusal: these are the
// tools that can change what the member's ledger says or put text on their
// profile, and each one is supposed to be hard to trigger by accident.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
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
  });
  const tool = (name: string) => defs.find((d) => d.name === name)!;
  // Parsed through the declared input schema first, the way the SDK dispatches:
  // that parse is where schema defaults are applied, so a handler called raw
  // sees arguments no real caller could send.
  // async so a schema rejection surfaces as a rejected promise, the same way
  // the SDK reports one, rather than throwing synchronously out of the caller.
  const call = async (name: string, args: unknown) => {
    const def = tool(name);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
  return { fixture, seeded, tool, call };
}

describe('linkedin_claim_manage', () => {
  it('proposes a claim that cites an artifact', async () => {
    const { fixture, seeded, call } = tools('claim-propose');
    const before = listClaims(fixture.db, {}, fixture.fts5).length;

    await call('linkedin_claim_manage', {
      action: 'propose',
      statement: 'The project ships a deterministic CSV parser.',
      evidence: [{ artifact_id: seeded.artifactId, location: {} }],
      method: 'manual',
    });

    expect(listClaims(fixture.db, {}, fixture.fts5).length).toBe(before + 1);
  });

  it('refuses to verify without an explicit confirmation', async () => {
    const { fixture, call } = tools('claim-verify-unconfirmed');
    const candidate = listClaims(fixture.db, {}, fixture.fts5).find((c) => c.state === 'candidate');
    if (!candidate) return;

    // Verification is the human decision this product exists to protect.
    await expect(
      call('linkedin_claim_manage', {
        action: 'verify',
        claim_id: candidate.id,
      }),
    ).rejects.toBeTruthy();
    expect(listClaims(fixture.db, {}, fixture.fts5).find((c) => c.id === candidate.id)?.state).toBe(
      'candidate',
    );
  });

  it('records a rejection as a permanent tombstone', async () => {
    const { fixture, call } = tools('claim-reject');
    const candidate = listClaims(fixture.db, {}, fixture.fts5).find((c) => c.state === 'candidate');
    if (!candidate) return;

    await call('linkedin_claim_manage', {
      action: 'reject',
      claim_id: candidate.id,
      reason: 'overstated',
      confirm: true,
    });

    expect(listClaims(fixture.db, {}, fixture.fts5).find((c) => c.id === candidate.id)?.state).toBe(
      'rejected',
    );
  });

  it('refuses an unknown claim id', async () => {
    const { call } = tools('claim-unknown');
    await expect(
      call('linkedin_claim_manage', {
        action: 'verify',
        claim_id: 'clm_nope',
        confirm: true,
      }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_draft_write and validate', () => {
  it('writes a draft and returns its revision hash', async () => {
    const { fixture, call } = tools('draft-write');

    const out = (await call('linkedin_draft_write', {
      body_text: 'A sentence backed by nothing in particular, written for a test.',
      visibility: 'PUBLIC',
    })) as { draft_id: string; revision_hash: string };

    expect(out.draft_id).toMatch(/^drf_/);
    expect(out.revision_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(listDrafts(fixture.db).some((d) => d.id === out.draft_id)).toBe(true);
  });

  it('validates a draft and reports each check by name', async () => {
    const { fixture, call } = tools('draft-validate');
    const { draft } = writeDraft(fixture.db, {
      body_text: 'It cut recovery time by 87%, a number no claim contains.',
      visibility: 'PUBLIC',
    });

    const out = (await call('linkedin_draft_validate', {
      draft_id: draft.id,
    })) as { checks: Array<{ check: string; passed: boolean }>; passed: boolean };

    expect(out.checks.length).toBeGreaterThan(3);
    // An invented metric is a hard block, not a warning.
    expect(out.passed).toBe(false);
    expect(out.checks.some((c) => !c.passed)).toBe(true);
  });

  it('refuses to validate a draft that does not exist', async () => {
    const { call } = tools('draft-missing');
    await expect(call('linkedin_draft_validate', { draft_id: 'drf_nope' })).rejects.toBeTruthy();
  });
});

describe('linkedin_approval_decide', () => {
  it('refuses a grant whose revision hash does not match the preview', async () => {
    const { seeded, call } = tools('approval-hash-mismatch');

    await expect(
      call('linkedin_approval_decide', {
        action: 'grant',
        approval_id: seeded.approvalId,
        revision_hash: 'a'.repeat(64),
        command: `APPROVE ${seeded.approvalId} ${'a'.repeat(64)}`,
        confirm: true,
      }),
    ).rejects.toMatchObject({ blockers: ['revision_hash_mismatch'] });
  });

  it('refuses a deny whose command does not match exactly', async () => {
    const { seeded, call } = tools('approval-bad-deny');

    await expect(
      call('linkedin_approval_decide', {
        action: 'deny',
        approval_id: seeded.approvalId,
        reason: 'not now',
        command: 'REJECT the-wrong-id',
        confirm: true,
      }),
    ).rejects.toMatchObject({ blockers: ['confirmation_required'] });
  });

  it('revises a draft, invalidating the approval bound to the old text', async () => {
    const { fixture, seeded, call } = tools('approval-revise');

    const out = (await call('linkedin_approval_decide', {
      action: 'revise',
      approval_id: seeded.approvalId,
      body_text: 'Replacement text the member actually wants to publish.',
      command: `REVISE ${seeded.approvalId}`,
      confirm: true,
    })) as { approval_state: string; revision_hash: string };

    // The old approval cannot survive the text it was bound to changing.
    expect(out.approval_state).not.toBe('granted');
    expect(out.revision_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      fixture.db.get('SELECT state FROM approvals WHERE id = ?', seeded.approvalId)?.['state'],
    ).not.toBe('granted');
  });
});

describe('linkedin_publish_execute', () => {
  it('refuses the live adapter without the exact PUBLISH command', async () => {
    const { seeded, call } = tools('publish-no-command');

    await expect(
      call('linkedin_publish_execute', {
        approval_id: seeded.approvalId,
        adapter: 'linkedin',
        confirm: true,
      }),
    ).rejects.toMatchObject({ blockers: ['confirmation_required'] });
  });

  it('refuses the live adapter while live_publishing is off', async () => {
    const { seeded, call } = tools('publish-feature-off');

    await expect(
      call('linkedin_publish_execute', {
        approval_id: seeded.approvalId,
        adapter: 'linkedin',
        command: `PUBLISH ${seeded.approvalId}`,
        confirm: true,
      }),
    ).rejects.toMatchObject({ blockers: ['feature_disabled:live_publishing'] });
  });

  it('refuses to execute an approval that was never granted', async () => {
    const { seeded, call } = tools('publish-ungranted');

    await expect(
      call('linkedin_publish_execute', {
        approval_id: seeded.approvalId,
        adapter: 'dry_run',
      }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_publication_reconcile', () => {
  it('refuses to reconcile a publication that does not exist', async () => {
    const { call } = tools('reconcile-missing');

    await expect(
      call('linkedin_publication_reconcile', {
        publication_id: 'pub_nope',
        found: true,
        confirm: true,
      }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_purge_run', () => {
  it('runs a retention sweep and reports the DMA footprint', async () => {
    const { call } = tools('purge-sweep');

    const out = (await call('linkedin_purge_run', {
      mode: 'retention_sweep',
    })) as { sweep?: Record<string, unknown> };

    expect(out.sweep).toBeTruthy();
  });

  it('refuses a full purge without the exact phrase', async () => {
    const { fixture, call } = tools('purge-phrase');

    await expect(
      call('linkedin_purge_run', {
        mode: 'purge_all',
        confirm_phrase: 'delete all local data',
      }),
    ).rejects.toBeTruthy();
    expect(Number(fixture.db.get('SELECT COUNT(*) AS n FROM claims')?.['n'])).toBeGreaterThan(0);
  });

  it('refuses a DMA prune with a future cutoff', async () => {
    const { call } = tools('purge-future');

    await expect(
      call('linkedin_purge_run', {
        mode: 'prune_dma',
        before: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_audit_query', () => {
  it('verifies the chain on request', async () => {
    const { call } = tools('audit-chain');

    const out = (await call('linkedin_audit_query', {
      verify_chain: true,
      limit: 5,
    })) as { chain?: { valid: boolean }; events: unknown[] };

    expect(out.chain?.valid).toBe(true);
    expect(out.events.length).toBeLessThanOrEqual(5);
  });

  it('refuses a malformed pagination cursor rather than guessing', async () => {
    const { call } = tools('audit-cursor');

    await expect(
      call('linkedin_audit_query', { cursor: 'not-base64url-json' }),
    ).rejects.toBeTruthy();
  });
});
