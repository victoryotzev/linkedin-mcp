import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectConflicts,
  enableSourceFromDashboard,
  importSnapshot,
  listConflicts,
  registerSource,
  runImport,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// The change-set tools as a model reaches them, and the conflict list's filters.

let fixture: Fixture;
let evidence: string;
let call: (name: string, args: unknown) => Promise<unknown>;

beforeEach(async () => {
  fixture = createFixture('changeset-tools');
  seedHealthy(fixture);
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-ctev-'));

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
  importSnapshot(fixture.db, fixture.store, source.id);

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
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('linkedin_changeset_generate', () => {
  it('produces a set of patches from the diff', async () => {
    const out = (await call('linkedin_changeset_generate', { title: 'headline refresh' })) as {
      change_set: { id: string; patches: Array<{ field_key: string; state: string }> };
    };

    expect(out.change_set.id).toMatch(/^chg_/);
    expect(out.change_set.patches.length).toBeGreaterThan(0);
    expect(out.change_set.patches[0]?.state).toBe('proposed');
  });

  it('narrows to the sections it was given', async () => {
    const out = (await call('linkedin_changeset_generate', {
      title: 'headline only',
      sections: ['headline'],
    })) as { change_set: { patches: Array<{ field_key: string }> } };

    expect(out.change_set.patches.every((p) => p.field_key === 'headline')).toBe(true);
  });

  it('refuses a base snapshot that does not exist', async () => {
    await expect(
      call('linkedin_changeset_generate', { title: 'x', base_snapshot_id: 'snp_nope' }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_changeset_get and review', () => {
  async function generated(): Promise<{ id: string; patchId: string }> {
    const out = (await call('linkedin_changeset_generate', { title: 'to review' })) as {
      change_set: { id: string; patches: Array<{ id: string }> };
    };
    return { id: out.change_set.id, patchId: out.change_set.patches[0]!.id };
  }

  it('reads a set back with its patches', async () => {
    const { id } = await generated();

    const out = (await call('linkedin_changeset_get', { change_set_id: id })) as {
      change_set: { id: string; patches: unknown[] };
    };

    expect(out.change_set.id).toBe(id);
    expect(out.change_set.patches.length).toBeGreaterThan(0);
  });

  it('refuses a set it does not know', async () => {
    await expect(
      call('linkedin_changeset_get', { change_set_id: 'chg_nope' }),
    ).rejects.toBeTruthy();
  });

  it('accepts a patch', async () => {
    const { patchId } = await generated();

    const out = (await call('linkedin_changeset_review', {
      patch_id: patchId,
      action: 'accept',
    })) as { patch: { state: string } };

    expect(out.patch.state).toBe('approved');
  });

  it('rejects one with a note', async () => {
    const { patchId } = await generated();

    const out = (await call('linkedin_changeset_review', {
      patch_id: patchId,
      action: 'reject',
      note: 'the wording overstates it',
    })) as { patch: { state: string } };

    expect(out.patch.state).toBe('rejected');
  });

  it('edits one, and the edit is what would be pasted', async () => {
    const { patchId } = await generated();

    const out = (await call('linkedin_changeset_review', {
      patch_id: patchId,
      action: 'edit',
      new_text: 'A headline the member wrote themselves.',
    })) as { patch: { new_text: string } };

    expect(out.patch.new_text).toBe('A headline the member wrote themselves.');
  });

  it('refuses an edit with no text', async () => {
    const { patchId } = await generated();

    await expect(
      call('linkedin_changeset_review', { patch_id: patchId, action: 'edit', new_text: '' }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_changeset_export', () => {
  it('returns the bundle once something is approved', async () => {
    const generated = (await call('linkedin_changeset_generate', { title: 'to export' })) as {
      change_set: { id: string; patches: Array<{ id: string }> };
    };
    await call('linkedin_changeset_review', {
      patch_id: generated.change_set.patches[0]!.id,
      action: 'accept',
    });

    const out = (await call('linkedin_changeset_export', {
      change_set_id: generated.change_set.id,
    })) as { change_set_id: string; entries: Array<{ exact_text: string; ui_hint: string }> };

    expect(out.change_set_id).toBe(generated.change_set.id);
    expect(out.entries.length).toBeGreaterThan(0);
    // There is no profile-edit API: this text and this hint are the product's
    // whole output for a profile change.
    expect(out.entries[0]?.exact_text.length).toBeGreaterThan(0);
    expect(out.entries[0]?.ui_hint.length).toBeGreaterThan(0);
  });

  it('refuses to export a set with nothing approved in it', async () => {
    const generated = (await call('linkedin_changeset_generate', { title: 'nothing yet' })) as {
      change_set: { id: string };
    };

    await expect(
      call('linkedin_changeset_export', { change_set_id: generated.change_set.id }),
    ).rejects.toBeTruthy();
  });
});

describe('linkedin_patch_mark_applied', () => {
  it('needs the attestation, and records it', async () => {
    const generated = (await call('linkedin_changeset_generate', { title: 'to apply' })) as {
      change_set: { patches: Array<{ id: string }> };
    };
    const patchId = generated.change_set.patches[0]!.id;
    await call('linkedin_changeset_review', { patch_id: patchId, action: 'accept' });

    await expect(call('linkedin_patch_mark_applied', { patch_id: patchId })).rejects.toBeTruthy();

    const out = (await call('linkedin_patch_mark_applied', {
      patch_id: patchId,
      confirm: true,
    })) as { patch: { state: string } };
    expect(out.patch.state).toBe('applied');
  });
});

describe('listing conflicts', () => {
  it('filters by state and by type', () => {
    detectConflicts(fixture.db);

    const open = listConflicts(fixture.db, { state: 'open' });
    for (const conflict of open) expect(conflict.state).toBe('open');

    const contradictions = listConflicts(fixture.db, { type: 'contradiction' });
    for (const conflict of contradictions) expect(conflict.type).toBe('contradiction');

    expect(listConflicts(fixture.db, { state: 'dismissed' })).toEqual([]);
  });

  it('finds nothing to report a second time, having already reported it', () => {
    const first = detectConflicts(fixture.db);
    const second = detectConflicts(fixture.db);

    // Detection runs after every claim change. Re-reporting the same pair each
    // time would bury the new ones.
    expect(first.created.length).toBeGreaterThanOrEqual(0);
    expect(second.created).toEqual([]);
  });
});
