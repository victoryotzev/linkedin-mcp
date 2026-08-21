import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  enableSourceFromDashboard,
  exportChangeSet,
  generateChangeSet,
  getChangeSet,
  importSnapshot,
  markPatchApplied,
  proposeClaim,
  registerSource,
  reviewPatch,
  runImport,
  seedCanonicalSections,
  updateSection,
  verifyClaim,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { makeZip } from '../helpers/makeZip.ts';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let home: string;
let evidenceDir: string;
let db: SqliteDriver;
let store: ArtifactStore;
let verifiedClaimId: string;

function writeExportZip(headline: string): string {
  const zipPath = join(
    evidenceDir,
    `export-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  writeFileSync(
    zipPath,
    makeZip([
      {
        name: 'Profile.csv',
        data: Buffer.from(
          'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
            `Alex,Rivera,,,,${headline},Old summary.,Software,,Ghent,,,\n`,
        ),
      },
    ]),
  );
  return zipPath;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-chg-'));
  evidenceDir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-chgev-'));
  const opened = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  db = opened.db;
  migrate(db);
  seedCanonicalSections(db);
  store = new ArtifactStore(join(home, 'artifacts'));

  const source = registerSource(db, {
    path: writeExportZip('Old Headline'),
    kind: 'linkedin_export',
    trust: 'personal_doc',
    label: 'export v1',
    dataHome: home,
  });
  enableSourceFromDashboard(db, source.id);
  await runImport(db, store, source.id);
  importSnapshot(db, store, source.id);

  const { artifactId } = seedSourceAndArtifact(db);
  const claim = proposeClaim(db, {
    statement: 'Alex builds local-first products and MCP tooling.',
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'manual',
  });
  verifiedClaimId = verifyClaim(db, { claim_id: claim.id, confirm: true }).id;

  updateSection(db, {
    section_key: 'headline',
    content_text: 'Full-Stack Developer — Local-First & MCP Tooling',
    claim_ids: [verifiedClaimId],
    author: 'user',
    based_on_revision: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('change sets', () => {
  it('generates evidence-linked patches from the canonical-vs-snapshot diff', () => {
    const changeSet = generateChangeSet(db, { title: 'headline refresh' });
    expect(changeSet.patches).toHaveLength(1);
    const patch = changeSet.patches[0]!;
    expect(patch.field_key).toBe('headline');
    expect(patch.old_text).toBe('Old Headline');
    expect(patch.new_text).toBe('Full-Stack Developer — Local-First & MCP Tooling');
    expect(patch.char_limit).toBe(220);
    expect(patch.char_limit_ok).toBe(true);
    expect(patch.claim_ids).toEqual([verifiedClaimId]);
    expect(patch.state).toBe('proposed');
  });

  it('blocks generation when a cited claim is no longer verified', () => {
    db.run("UPDATE claims SET state = 'expired' WHERE id = ?", verifiedClaimId);
    try {
      generateChangeSet(db, { title: 'stale evidence' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('EVIDENCE_NOT_VERIFIED');
    }
  });

  it('walks accept -> export -> applied -> auto-verified-by-next-snapshot', async () => {
    const changeSet = generateChangeSet(db, { title: 'headline refresh' });
    const patch = changeSet.patches[0]!;

    // Export before approval fails.
    expect(() => exportChangeSet(db, changeSet.id)).toThrowError(DomainError);

    reviewPatch(db, { patch_id: patch.id, action: 'accept' });
    const bundle = exportChangeSet(db, changeSet.id);
    // Copy-paste text is byte-identical to the approved patch.
    expect(bundle.entries[0]!.exact_text).toBe(patch.new_text);
    expect(bundle.entries[0]!.ui_hint).toContain('Headline');
    expect(getChangeSet(db, changeSet.id).state).toBe('exported');

    expect(() =>
      markPatchApplied(db, { patch_id: patch.id, confirm: false, actor: 'mcp_host' }),
    ).toThrowError(DomainError);
    expect(getChangeSet(db, changeSet.id).patches[0]!.state).toBe('approved');
    const applied = markPatchApplied(db, { patch_id: patch.id, confirm: true, actor: 'dashboard' });
    const appliedEvent = db.get(
      "SELECT actor, payload_json FROM audit_events WHERE event_type = 'profile_patch.marked_applied'",
    );
    expect(appliedEvent?.['actor']).toBe('dashboard');
    expect(JSON.parse(String(appliedEvent?.['payload_json']))['applied_at']).toBe(
      applied.applied_at,
    );

    // User pastes into LinkedIn; a later export reflects the new headline.
    const source2 = registerSource(db, {
      path: writeExportZip('Full-Stack Developer — Local-First & MCP Tooling'),
      kind: 'linkedin_export',
      trust: 'personal_doc',
      label: 'export v2',
      dataHome: home,
    });
    enableSourceFromDashboard(db, source2.id);
    await runImport(db, store, source2.id);
    const snap2 = importSnapshot(db, store, source2.id);

    const after = getChangeSet(db, changeSet.id).patches[0]!;
    expect(after.state).toBe('applied');
    expect(after.applied_verified_snapshot_id).toBe(snap2.id);
    expect(snap2.warnings.join(' ')).toContain('auto-verified');
  });

  it('edits re-hash and drop approval; terminal states refuse review', () => {
    const changeSet = generateChangeSet(db, { title: 'edit flow' });
    const patch = changeSet.patches[0]!;
    reviewPatch(db, { patch_id: patch.id, action: 'accept' });
    const edited = reviewPatch(db, {
      patch_id: patch.id,
      action: 'edit',
      new_text: 'Full-Stack Developer | Local-First Systems & MCP Tooling',
    });
    expect(edited.state).toBe('proposed'); // approval did not survive the edit
    expect(edited.revision_hash).not.toBe(patch.revision_hash);

    reviewPatch(db, { patch_id: patch.id, action: 'reject', note: 'changed direction' });
    try {
      reviewPatch(db, { patch_id: patch.id, action: 'accept' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('TERMINAL_STATE');
    }
  });

  it('refuses generation when nothing differs', () => {
    // Overwrite canonical to match the snapshot exactly.
    const current = getChangeSet(db, generateChangeSet(db, { title: 'tmp' }).id);
    void current;
    updateSection(db, {
      section_key: 'headline',
      content_text: 'Old Headline',
      claim_ids: [verifiedClaimId],
      author: 'user',
      based_on_revision: db.get(
        "SELECT current_revision_id AS id FROM canonical_sections WHERE section_key = 'headline'",
      )!['id'] as string,
    });
    try {
      generateChangeSet(db, { title: 'no-op', sections: ['headline'] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('INVALID_INPUT');
    }
  });
});
