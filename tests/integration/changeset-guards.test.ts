import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enableSourceFromDashboard,
  exportChangeSet,
  generateChangeSet,
  getChangeSet,
  importSnapshot,
  markPatchApplied,
  registerSource,
  rejectClaim,
  reviewPatch,
  runImport,
  setSetting,
  updateSection,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// The gates between a proposed patch and text on a public profile.
//
// Each one exists because the state can change between the member accepting a
// patch and exporting it: a claim can be rejected, a field limit can be
// lowered, an edit can replace the text the citations were derived from. The
// export is the last moment anything can be checked, so it checks again.

let fixture: Fixture;
let evidence: string;
let seeded: ReturnType<typeof seedHealthy>;
let verifiedClaimId: string;

beforeEach(async () => {
  fixture = createFixture('changeset-guards');
  seeded = seedHealthy(fixture);
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-csev-'));

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
  verifiedClaimId = seeded.verifiedId;
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

const firstPatch = (id: string) => getChangeSet(fixture.db, id).patches[0]!;

describe('generating a change set', () => {
  it('refuses when there is no snapshot to diff against', () => {
    const empty = createFixture('changeset-no-snapshot');
    try {
      seedHealthy(empty);
      // Without a snapshot there is nothing to compare the canonical text to,
      // so every field would look like a change.
      expect(() => generateChangeSet(empty.db, { title: 'nothing to diff' })).toThrow(
        /no snapshot/i,
      );
    } finally {
      empty.close();
    }
  });

  it('refuses a base snapshot that does not exist', () => {
    expect(() =>
      generateChangeSet(fixture.db, { title: 'x', base_snapshot_id: 'snp_nope' }),
    ).toThrow();
  });

  it('diffs only the sections it was asked about', () => {
    const changeSet = generateChangeSet(fixture.db, {
      title: 'headline only',
      sections: ['headline'],
    });

    expect(changeSet.patches.every((p) => p.field_key === 'headline')).toBe(true);
  });
});

describe('reviewing a patch', () => {
  it('supersedes one, taking it out of the set without rejecting it', () => {
    const changeSet = generateChangeSet(fixture.db, { title: 'supersede' });
    const patch = firstPatch(changeSet.id);

    const result = reviewPatch(fixture.db, { patch_id: patch.id, action: 'supersede' });

    // Superseded is not rejected: the member did not decide against the text,
    // something newer replaced it.
    expect(result.state).toBe('superseded');
  });

  it('refuses an edit with no text in it', () => {
    const changeSet = generateChangeSet(fixture.db, { title: 'empty edit' });
    const patch = firstPatch(changeSet.id);

    for (const text of ['', '   ']) {
      expect(() =>
        reviewPatch(fixture.db, { patch_id: patch.id, action: 'edit', new_text: text }),
      ).toThrow(/requires new_text/i);
    }
  });

  it('re-derives the citations from the edited text', () => {
    const changeSet = generateChangeSet(fixture.db, { title: 'edit citations' });
    const patch = firstPatch(changeSet.id);

    const edited = reviewPatch(fixture.db, {
      patch_id: patch.id,
      action: 'edit',
      new_text: 'Something entirely unrelated to any verified claim.',
    });

    // An edit replaces the text wholesale. Keeping the old citations would
    // leave a sentence pointing at claims that no longer say anything about it.
    expect(edited.new_text).toContain('unrelated');
    expect(edited.claim_ids.length).toBeLessThanOrEqual(patch.claim_ids.length);
  });

  it('reports an edit that goes over the field limit', () => {
    setSetting(fixture.db, 'field_limits', { headline: 20 }, { confirm: true });
    const changeSet = generateChangeSet(fixture.db, { title: 'over limit' });
    const patch = firstPatch(changeSet.id);

    const edited = reviewPatch(fixture.db, {
      patch_id: patch.id,
      action: 'edit',
      new_text: 'A headline far longer than twenty characters allows.',
    });

    // Pasting text LinkedIn will truncate leaves a sentence cut in half on the
    // member's profile, so this has to be visible before they paste.
    expect(edited.char_limit_ok).toBe(false);
  });

  it('refuses to act on a patch that is already settled', () => {
    const changeSet = generateChangeSet(fixture.db, { title: 'terminal' });
    const patch = firstPatch(changeSet.id);
    reviewPatch(fixture.db, { patch_id: patch.id, action: 'reject', note: 'no' });

    expect(() => reviewPatch(fixture.db, { patch_id: patch.id, action: 'accept' })).toThrow(
      /rejected/i,
    );
  });

  it('refuses a patch it does not know', () => {
    expect(() => reviewPatch(fixture.db, { patch_id: 'pat_nope', action: 'accept' })).toThrow(
      /not found/i,
    );
  });
});

describe('exporting a change set', () => {
  function accepted(): string {
    const changeSet = generateChangeSet(fixture.db, { title: 'to export' });
    reviewPatch(fixture.db, { patch_id: firstPatch(changeSet.id).id, action: 'accept' });
    return changeSet.id;
  }

  it('lists each approved patch with the exact text and where it goes', () => {
    const bundle = exportChangeSet(fixture.db, accepted());

    expect(bundle.entries.length).toBeGreaterThan(0);
    expect(bundle.entries[0]?.exact_text.length).toBeGreaterThan(0);
    // There is no profile-edit API; the hint is how the member finds the field.
    expect(bundle.entries[0]?.ui_hint.length).toBeGreaterThan(0);
  });

  it('refuses when nothing has been approved', () => {
    const changeSet = generateChangeSet(fixture.db, { title: 'nothing approved' });

    expect(() => exportChangeSet(fixture.db, changeSet.id)).toThrow();
  });

  it('refuses to export an approved patch that is over the field limit', () => {
    // The limit is evaluated when the patch is generated, so this is the shape
    // that reaches the export gate: a patch that was always too long and was
    // accepted anyway.
    setSetting(fixture.db, 'field_limits', { headline: 5 }, { confirm: true });
    const changeSet = generateChangeSet(fixture.db, { title: 'over limit' });
    const patch = firstPatch(changeSet.id);
    expect(patch.char_limit_ok).toBe(false);
    reviewPatch(fixture.db, { patch_id: patch.id, action: 'accept' });

    expect(() => exportChangeSet(fixture.db, changeSet.id)).toThrow(/char limits/i);
  });

  it('refuses when a claim behind an approved patch was rejected since', () => {
    const id = accepted();
    rejectClaim(fixture.db, {
      claim_id: verifiedClaimId,
      confirm: true,
      reason: 'overstated after all',
      reviewer: 'user:test',
    });

    // This is the last gate before text leaves for a public profile, and claims
    // can be rejected between accept and export.
    expect(() => exportChangeSet(fixture.db, id)).toThrow();
  });
});

describe('marking a patch applied', () => {
  function approved(): string {
    const changeSet = generateChangeSet(fixture.db, { title: 'to apply' });
    const patch = firstPatch(changeSet.id);
    reviewPatch(fixture.db, { patch_id: patch.id, action: 'accept' });
    return patch.id;
  }

  it('requires the confirmation that says the member actually pasted it', () => {
    expect(() =>
      markPatchApplied(fixture.db, {
        patch_id: approved(),
        confirm: false,
        actor: 'dashboard',
      }),
    ).toThrow(/pass confirm/i);
  });

  it('refuses a patch that was never approved', () => {
    const changeSet = generateChangeSet(fixture.db, { title: 'not approved' });

    expect(() =>
      markPatchApplied(fixture.db, {
        patch_id: firstPatch(changeSet.id).id,
        confirm: true,
        actor: 'dashboard',
      }),
    ).toThrow(/only approved patches/i);
  });

  it('refuses an applied_at that is not a timestamp', () => {
    expect(() =>
      markPatchApplied(fixture.db, {
        patch_id: approved(),
        confirm: true,
        actor: 'dashboard',
        applied_at: 'last tuesday',
      }),
    ).toThrow(/ISO-8601/i);
  });

  it('records when the member says they pasted it, and leaves it unverified', () => {
    const patchId = approved();

    const applied = markPatchApplied(fixture.db, {
      patch_id: patchId,
      confirm: true,
      actor: 'dashboard',
      applied_at: '2026-05-01T09:00:00.000Z',
    });

    expect(applied.state).toBe('applied');
    expect(applied.applied_at).toBe('2026-05-01T09:00:00.000Z');
    // Nothing observed LinkedIn. Until a later snapshot confirms it, this is
    // the member's word and the record says so.
    expect(applied.applied_verified_snapshot_id ?? null).toBeNull();
  });
});

describe('a second change set over the same divergence', () => {
  it('can be generated after the first was rejected', () => {
    const first = generateChangeSet(fixture.db, { title: 'first attempt' });
    reviewPatch(fixture.db, {
      patch_id: firstPatch(first.id).id,
      action: 'reject',
      note: 'wrong wording',
    });

    // Rejecting a patch is not rejecting the underlying divergence: the profile
    // still disagrees with the evidence, and the member can try again.
    //
    // updateSection is optimistically concurrent — it wants the revision the
    // caller read, so two surfaces cannot overwrite each other silently.
    const current = String(
      fixture.db.get(
        "SELECT current_revision_id FROM canonical_sections WHERE section_key = 'headline'",
      )?.['current_revision_id'] ?? '',
    );
    updateSection(fixture.db, {
      section_key: 'headline',
      content_text: 'The project contains 181 test files.',
      claim_ids: [verifiedClaimId],
      author: 'user',
      based_on_revision: current || null,
    });
    const second = generateChangeSet(fixture.db, { title: 'second attempt' });

    expect(second.id).not.toBe(first.id);
    expect(second.patches.length).toBeGreaterThan(0);
  });
});
