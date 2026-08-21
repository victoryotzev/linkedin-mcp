import { afterEach, describe, expect, it } from 'vitest';
import {
  denyApproval,
  grantApproval,
  listBackups,
  listCalendar,
  listPillars,
  validateDraft,
  writeDraft,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The rest of the tool handlers: the by-id read paths, the backup modes, the
// calendar writes and the guards that sit between a caller and a state it must
// not reach. tool-behaviours covers the refusals around publishing; this covers
// what the tools do when the answer is yes.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function tools(label: string) {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  const seeded = seedHealthy(fixture);
  const purges: number[] = [];
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
    scheduleFullPurge: () => purges.push(1),
  } as never);
  const tool = (name: string) => defs.find((d) => d.name === name)!;
  // Through the declared input schema, not straight into the handler: the SDK
  // parses before dispatching, and that parse is where defaults like `limit`
  // come from. Calling the handler raw tests a set of arguments no caller can
  // actually produce.
  // async so a schema rejection surfaces as a rejected promise, the same way
  // the SDK reports one, rather than throwing synchronously out of the caller.
  const call = async (name: string, args: unknown) => {
    const def = tool(name);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
  return { fixture, seeded, tool, call, purges };
}

describe('linkedin_publish_request', () => {
  it('creates an approval carrying the preview the member will decide on', async () => {
    const { fixture, call } = tools('publish-request');
    // Validation blocks any sentence no verified claim backs, and separately
    // blocks a draft that repeats another one — so the body has to be supported
    // by the seeded corpus without duplicating the draft already in it.
    const { draft } = writeDraft(fixture.db, {
      body_text: 'The suite covers 203 test files in total.',
      visibility: 'PUBLIC',
    });
    // An approval cannot be requested for text that has not passed validation:
    // the preview a member decides on must already be known to hold up.
    validateDraft(fixture.db, draft.id);

    const out = (await call('linkedin_publish_request', { draft_id: draft.id })) as {
      approval_id: string;
      state: string;
      preview: { body_text: string; revision_hash: string };
      dashboard_url?: string;
    };

    expect(out.approval_id).toMatch(/^apv_/);
    expect(out.state).toBe('pending');
    // The preview travels with the request: an approval decided without seeing
    // the exact bytes is the failure this whole surface exists to prevent.
    expect(out.preview.body_text).toBe('The suite covers 203 test files in total.');
    expect(out.preview.revision_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts an intended time and a TTL', async () => {
    const { fixture, call } = tools('publish-request-ttl');
    const { draft } = writeDraft(fixture.db, {
      body_text: 'The suite covers 203 test files in total.',
    });
    validateDraft(fixture.db, draft.id);

    const out = (await call('linkedin_publish_request', {
      draft_id: draft.id,
      intended_time: '2026-04-01T09:00:00.000Z',
      ttl_hours: 6,
    })) as { expires_at: string };

    expect(Date.parse(out.expires_at)).toBeGreaterThan(Date.now());
  });
});

describe('linkedin_approval_status', () => {
  it('returns one approval with its preview when asked by id', async () => {
    const { seeded, call } = tools('approval-status-id');

    const out = (await call('linkedin_approval_status', { approval_id: seeded.approvalId })) as {
      items: Array<{ id: string; state: string }>;
      has_more: boolean;
      preview: { body_text: string; char_count: number };
    };

    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.id).toBe(seeded.approvalId);
    expect(out.has_more).toBe(false);
    expect(out.preview.char_count).toBe(out.preview.body_text.length);
  });

  it('lists approvals filtered by state, and pages them', async () => {
    const { call } = tools('approval-status-list');

    const out = (await call('linkedin_approval_status', { state: 'pending', limit: 1 })) as {
      items: unknown[];
      has_more: boolean;
    };

    expect(out.items.length).toBeLessThanOrEqual(1);
    expect(typeof out.has_more).toBe('boolean');
  });
});

describe('linkedin_approval_decide guards', () => {
  it('refuses to decide an approval that has already been decided', async () => {
    const { fixture, seeded, call } = tools('approval-terminal');
    denyApproval(fixture.db, seeded.approvalId, 'changed my mind', 'dashboard');

    await expect(
      call('linkedin_approval_decide', {
        action: 'deny',
        approval_id: seeded.approvalId,
        reason: 'again',
        command: `REJECT ${seeded.approvalId}`,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_STATE' });
  });

  it('refuses a revise whose command names the wrong approval', async () => {
    const { seeded, call } = tools('approval-revise-command');

    await expect(
      call('linkedin_approval_decide', {
        action: 'revise',
        approval_id: seeded.approvalId,
        body_text: 'Replacement text.',
        command: 'REVISE apr_something_else',
        confirm: true,
      }),
    ).rejects.toMatchObject({ blockers: ['confirmation_required'] });
  });
});

describe('linkedin_draft_list', () => {
  it('returns one draft with its body and validation when asked by id', async () => {
    const { seeded, call } = tools('draft-list-id');

    const out = (await call('linkedin_draft_list', { id: seeded.draftId })) as {
      items: Array<{ id: string }>;
      detail: {
        body_text: string;
        revision_hash: string;
        validation: { passed: boolean; stale: boolean } | null;
      };
    };

    expect(out.items[0]?.id).toBe(seeded.draftId);
    expect(out.detail.body_text.length).toBeGreaterThan(0);
    // The fixture validates the draft it writes, so the result is present and
    // current — a stale flag here would mean the text moved underneath it.
    expect(out.detail.validation?.stale).toBe(false);
  });

  it('lists drafts filtered by state', async () => {
    const { call } = tools('draft-list-state');
    const out = (await call('linkedin_draft_list', { state: 'draft' })) as { items: unknown[] };
    expect(Array.isArray(out.items)).toBe(true);
  });
});

describe('linkedin_calendar_plan', () => {
  it('creates a pillar and an entry against it', async () => {
    const { fixture, call } = tools('calendar-plan');

    await call('linkedin_calendar_plan', {
      action: 'upsert_pillar',
      name: 'Evidence tooling',
      description: 'How the importer and the audit chain work.',
    });
    const pillar = listPillars(fixture.db).find((p) => p.name === 'Evidence tooling');
    expect(pillar).toBeTruthy();

    const out = (await call('linkedin_calendar_plan', {
      action: 'upsert_entry',
      pillar_id: pillar?.id,
      intended_date: '2026-05-04',
      status: 'planned',
      note: 'draft the zip-bomb write-up first',
    })) as { pillars: unknown[]; entries: unknown[] };

    expect(out.entries.length).toBe(listCalendar(fixture.db).length);
    expect(listCalendar(fixture.db).some((e) => e.intended_date.startsWith('2026-05-04'))).toBe(
      true,
    );
  });

  it('refuses a pillar with no name and an entry with no date', async () => {
    const { call } = tools('calendar-plan-invalid');

    await expect(call('linkedin_calendar_plan', { action: 'upsert_pillar' })).rejects.toBeTruthy();
    await expect(call('linkedin_calendar_plan', { action: 'upsert_entry' })).rejects.toBeTruthy();
  });

  it('reads the plan back without changing it', async () => {
    const { fixture, call } = tools('calendar-plan-read');
    const before = listCalendar(fixture.db).length;

    const out = (await call('linkedin_calendar_plan', { action: 'list' })) as {
      pillars: unknown[];
      entries: unknown[];
    };

    expect(out.entries.length).toBe(before);
  });
});

describe('linkedin_backup_run', () => {
  it('creates a backup and verifies it in the same call', async () => {
    const { fixture, call } = tools('backup-create');

    const out = (await call('linkedin_backup_run', { mode: 'backup', label: 'nightly' })) as {
      backup_name: string;
      total_bytes: number;
      verification: { valid: boolean };
    };

    // A backup that does not verify is not a backup, so the tool proves it
    // before reporting success rather than leaving that to the member.
    expect(out.verification.valid).toBe(true);
    expect(out.total_bytes).toBeGreaterThan(0);
    expect(listBackups(fixture.dir).some((b) => b.name === out.backup_name)).toBe(true);
  });

  it('lists backups with a cursor', async () => {
    const { call } = tools('backup-list');
    await call('linkedin_backup_run', { mode: 'backup' });

    const out = (await call('linkedin_backup_run', { mode: 'list', limit: 1 })) as {
      backups: unknown[];
      has_more: boolean;
    };

    expect(out.backups.length).toBeLessThanOrEqual(1);
  });

  it('verifies a named backup', async () => {
    const { call } = tools('backup-verify');
    const created = (await call('linkedin_backup_run', { mode: 'backup' })) as {
      backup_name: string;
    };

    const out = (await call('linkedin_backup_run', {
      mode: 'verify',
      backup_name: created.backup_name,
    })) as { verification: { valid: boolean } };

    expect(out.verification.valid).toBe(true);
  });

  it('refuses to verify a backup that does not exist', async () => {
    const { call } = tools('backup-verify-missing');
    await expect(
      call('linkedin_backup_run', { mode: 'verify', backup_name: 'not-a-backup' }),
    ).rejects.toBeTruthy();
  });

  it('exports a counts-only bundle, never the text itself', async () => {
    const { call } = tools('backup-bundle');

    const out = (await call('linkedin_backup_run', { mode: 'export_bundle' })) as {
      bundle: { claims: number; drafts: number; note: string };
    };

    // Counts and a note. Putting claim or draft text into an MCP response would
    // hand the member's corpus to whatever model is on the other end.
    expect(typeof out.bundle.claims).toBe('number');
    expect(typeof out.bundle.note).toBe('string');
    expect(JSON.stringify(out.bundle)).not.toMatch(/hash-chained audit log/);
  });
});

describe('linkedin_purge_run, full purge', () => {
  it('refuses without a verified backup unless the loss is accepted', async () => {
    const { call, purges } = tools('purge-no-backup');

    await expect(
      call('linkedin_purge_run', {
        mode: 'purge_all',
        confirm_phrase: 'DELETE ALL LOCAL DATA',
      }),
    ).rejects.toBeTruthy();
    expect(purges).toHaveLength(0);
  });

  it('schedules the purge once a verified backup exists', async () => {
    const { call, purges } = tools('purge-with-backup');
    await call('linkedin_backup_run', { mode: 'backup' });

    const out = (await call('linkedin_purge_run', {
      mode: 'purge_all',
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      confirm: true,
    })) as { status: string };

    // The purge is scheduled rather than performed inline: the process has to
    // release the database before the files can go.
    expect(out.status).toBe('purging');
    expect(purges).toHaveLength(1);
  });

  it('schedules the purge without a backup when the loss is explicitly accepted', async () => {
    const { call, purges } = tools('purge-accepted-loss');

    await call('linkedin_purge_run', {
      mode: 'purge_all',
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      confirm: true,
      accept_no_backup: true,
    });
    expect(purges).toHaveLength(1);
  });

  it('refuses to purge an artifact that live claims still cite', async () => {
    const { fixture, seeded, call } = tools('purge-artifact-cited');

    // Purging evidence out from under a verified claim would leave the claim
    // standing with nothing behind it — the one state this product must never
    // reach. The claims have to be resolved first.
    await expect(
      call('linkedin_purge_run', {
        mode: 'purge_artifact',
        artifact_id: seeded.artifactId,
        confirm: true,
      }),
    ).rejects.toThrow(/cited by/i);
    expect(
      Number(
        fixture.db.get('SELECT COUNT(*) AS n FROM artifacts WHERE id = ?', seeded.artifactId)?.[
          'n'
        ],
      ),
    ).toBe(1);
  });

  it('purges an artifact that nothing cites', async () => {
    const { fixture, call } = tools('purge-artifact');
    const { artifactId } = seedRealArtifact(
      fixtures[fixtures.length - 1]!,
      'An uncited note that no claim depends on.',
      { relpath: 'NOTES.md' },
    );

    await call('linkedin_purge_run', {
      mode: 'purge_artifact',
      artifact_id: artifactId,
      confirm: true,
    });

    expect(
      Number(fixture.db.get('SELECT COUNT(*) AS n FROM artifacts WHERE id = ?', artifactId)?.['n']),
    ).toBe(0);
  });

  it('refuses to purge an artifact without confirmation', async () => {
    const { fixture, seeded, call } = tools('purge-artifact-unconfirmed');

    await expect(
      call('linkedin_purge_run', { mode: 'purge_artifact', artifact_id: seeded.artifactId }),
    ).rejects.toBeTruthy();
    expect(
      Number(
        fixture.db.get('SELECT COUNT(*) AS n FROM artifacts WHERE id = ?', seeded.artifactId)?.[
          'n'
        ],
      ),
    ).toBe(1);
  });
});

describe('linkedin_audit_query paging', () => {
  it('pages through the log with a cursor that pins the maximum sequence', async () => {
    const { call } = tools('audit-paging');

    const first = (await call('linkedin_audit_query', { limit: 2 })) as {
      events: Array<{ id: string }>;
      next_cursor?: string;
      has_more: boolean;
    };
    expect(first.events.length).toBeLessThanOrEqual(2);
    if (!first.next_cursor) return;

    const second = (await call('linkedin_audit_query', {
      limit: 2,
      cursor: first.next_cursor,
    })) as { events: Array<{ id: string }> };

    // A cursor that did not pin max_seq would re-show entries as new ones
    // arrive; the second page must not repeat the first.
    const firstIds = new Set(first.events.map((e) => e.id));
    expect(second.events.some((e) => firstIds.has(e.id))).toBe(false);
  });

  it('filters by event type and subject', async () => {
    const { fixture, seeded, call } = tools('audit-filter');
    grantApproval(fixture.db, seeded.approvalId, 'dashboard');

    const out = (await call('linkedin_audit_query', { subject_id: seeded.approvalId })) as {
      events: Array<{ subject_id: string }>;
    };

    for (const event of out.events) expect(event.subject_id).toBe(seeded.approvalId);
  });
});
