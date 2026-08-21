import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { appendAuditEvent } from './auditService.ts';
import { checkCoverage } from './coverageService.ts';
import { getProfile, type SectionKey } from './profileService.ts';
import { getSnapshot, latestSnapshot, type Snapshot } from './snapshotService.ts';
import { getSettingOrDefault } from './settingsService.ts';

// Copy/paste field patches: the permanent profile-change mechanism (no
// LinkedIn profile-edit API exists). A patch proposes exact new text for one
// LinkedIn field; the user applies it by hand; the next snapshot import
// verifies it landed.

// LinkedIn char limits are UNVERIFIED first-party (plan U3): these defaults
// are config, overridable via the 'field_limits' setting, and confirmed
// against real snapshots over time — never treated as truths.
const DEFAULT_FIELD_LIMITS: Record<string, number> = {
  headline: 220,
  about: 2600,
};

// These five are the whole of the LinkedIn surface a patch can target. The
// canonical profile also holds internal-only sections (audiences,
// positioning_brief, keyword_map) that have no LinkedIn field, no char limit
// and no place to paste them — UI_HINTS is therefore the allowlist, not just a
// lookup table.
const UI_HINTS: Record<string, string> = {
  headline: 'linkedin.com/in/you → pencil icon on the intro card → Headline',
  about: 'Profile → About section → pencil icon',
  experience: 'Profile → Experience → pencil icon on the position',
  education: 'Profile → Education → pencil icon on the entry',
  skills: 'Profile → Skills → add/edit skills individually',
};

// Evidence is re-checked at every gate a patch passes, not only at generation.
// A patch generated while its claims were verified could otherwise be accepted
// and exported as an "evidence-linked" copy/paste bundle after the member had
// rejected those very claims as false — and the export is the thing that goes
// onto a public profile.
function assertClaimsVerified(db: SqliteDriver, label: string, claimIds: readonly string[]): void {
  const offenders = claimIds.filter((claimId) => {
    const claim = db.get('SELECT state FROM claims WHERE id = ?', claimId);
    return !claim || String(claim['state']) !== 'verified';
  });
  if (offenders.length > 0) {
    throw new DomainError(
      'EVIDENCE_NOT_VERIFIED',
      `'${label}' cites claims that are no longer verified: ${offenders.join(', ')}; re-review them before continuing`,
      { blockers: ['evidence_withdrawn'] },
    );
  }
}

export interface FieldPatch {
  id: string;
  change_set_id: string;
  field_key: string;
  old_text: string;
  new_text: string;
  char_limit: number | null;
  char_count: number;
  char_limit_ok: boolean;
  claim_ids: string[];
  rationale: string | null;
  risk_note: string | null;
  kind: 'required_fix' | 'optional_improvement';
  state: 'proposed' | 'approved' | 'applied' | 'superseded' | 'rejected';
  applied_at: string | null;
  applied_verified_snapshot_id: string | null;
  revision_hash: string;
}

export interface ChangeSet {
  id: string;
  title: string;
  base_snapshot_id: string;
  state: 'open' | 'exported' | 'closed';
  created_at: string;
  patches: FieldPatch[];
}

function patchHash(fieldKey: string, newText: string): string {
  return createHash('sha256').update(`${fieldKey}\n${newText}`, 'utf8').digest('hex');
}

function fieldLimits(db: SqliteDriver): Record<string, number> {
  return { ...DEFAULT_FIELD_LIMITS, ...getSettingOrDefault(db, 'field_limits', {}) };
}

function rowToPatch(row: Record<string, unknown>): FieldPatch {
  return {
    id: String(row['id']),
    change_set_id: String(row['change_set_id']),
    field_key: String(row['field_key']),
    old_text: String(row['old_text']),
    new_text: String(row['new_text']),
    char_limit: row['char_limit'] === null ? null : Number(row['char_limit']),
    char_count: Number(row['char_count']),
    char_limit_ok: Number(row['char_limit_ok']) === 1,
    claim_ids: JSON.parse(String(row['claim_ids_json'])) as string[],
    rationale: (row['rationale'] as string | null) ?? null,
    risk_note: (row['risk_note'] as string | null) ?? null,
    kind: String(row['kind']) as FieldPatch['kind'],
    state: String(row['state']) as FieldPatch['state'],
    applied_at: (row['applied_at'] as string | null) ?? null,
    applied_verified_snapshot_id: (row['applied_verified_snapshot_id'] as string | null) ?? null,
    revision_hash: String(row['revision_hash']),
  };
}

export function getChangeSet(db: SqliteDriver, id: string): ChangeSet {
  const row = db.get('SELECT * FROM change_sets WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `change set ${id} not found`);
  return {
    id: String(row['id']),
    title: String(row['title']),
    base_snapshot_id: String(row['base_snapshot_id']),
    state: String(row['state']) as ChangeSet['state'],
    created_at: String(row['created_at']),
    patches: db
      .all('SELECT * FROM field_patches WHERE change_set_id = ? ORDER BY field_key', id)
      .map(rowToPatch),
  };
}

export interface ChangeSetSummary {
  id: string;
  title: string;
  base_snapshot_id: string;
  state: ChangeSet['state'];
  created_at: string;
  patch_count: number;
  proposed_count: number;
  approved_count: number;
}

// Summaries without loading every patch. The dashboard used to run raw SQL for
// the id list and then call getChangeSet per row, which is a query per patch on
// a screen that only needed counts.
export function listChangeSets(
  db: SqliteDriver,
  filters: { limit?: number; offset?: number } = {},
): ChangeSetSummary[] {
  return db
    .all(
      `SELECT cs.*,
              COUNT(p.id) AS patch_count,
              SUM(CASE WHEN p.state = 'proposed' THEN 1 ELSE 0 END) AS proposed_count,
              SUM(CASE WHEN p.state = 'approved' THEN 1 ELSE 0 END) AS approved_count
       FROM change_sets cs
       LEFT JOIN field_patches p ON p.change_set_id = cs.id
       GROUP BY cs.id
       ORDER BY cs.created_at DESC
       LIMIT ? OFFSET ?`,
      filters.limit ?? 20,
      filters.offset ?? 0,
    )
    .map((row) => ({
      id: String(row['id']),
      title: String(row['title']),
      base_snapshot_id: String(row['base_snapshot_id']),
      state: String(row['state']) as ChangeSet['state'],
      created_at: String(row['created_at']),
      patch_count: Number(row['patch_count'] ?? 0),
      proposed_count: Number(row['proposed_count'] ?? 0),
      approved_count: Number(row['approved_count'] ?? 0),
    }));
}

// Generates patches for every canonical section that (a) has content, (b)
// maps to a LinkedIn field, and (c) differs from the base snapshot. Cited
// claims are re-checked as VERIFIED at generate time — a claim that expired
// since the canonical revision was written blocks the patch.
export function generateChangeSet(
  db: SqliteDriver,
  input: {
    title: string;
    base_snapshot_id?: string;
    sections?: SectionKey[];
    required_fields?: string[];
  },
): ChangeSet {
  const snapshot: Snapshot | null = input.base_snapshot_id
    ? getSnapshot(db, input.base_snapshot_id)
    : latestSnapshot(db);
  if (!snapshot) {
    throw new DomainError(
      'NOT_FOUND',
      'no snapshot to base the change set on — run linkedin_snapshot_import first',
    );
  }

  const profile = getProfile(db, input.sections);
  const limits = fieldLimits(db);
  const required = new Set(input.required_fields ?? []);
  const now = new Date().toISOString();

  return withWriteTx(db, () => {
    const changeSetId = newId('chg');
    const patches: FieldPatch[] = [];

    for (const [sectionKey, revision] of Object.entries(profile)) {
      if (!revision || revision.content_text.trim().length === 0) continue;
      // The loop's contract has always been "sections that map to a LinkedIn
      // field", but nothing enforced it, so audiences/positioning_brief/
      // keyword_map were emitted as copy/paste patches with no destination.
      if (!(sectionKey in UI_HINTS)) continue;
      const snapField = snapshot.fields[sectionKey];
      const oldText = snapField?.value_text ?? '';
      if (oldText === revision.content_text) continue;

      assertClaimsVerified(db, sectionKey, revision.claim_ids);

      const limit = limits[sectionKey] ?? null;
      const patch: FieldPatch = {
        id: newId('pat'),
        change_set_id: changeSetId,
        field_key: sectionKey,
        old_text: oldText,
        new_text: revision.content_text,
        char_limit: limit,
        char_count: revision.content_text.length,
        char_limit_ok: limit === null || revision.content_text.length <= limit,
        claim_ids: revision.claim_ids,
        rationale: revision.rationale,
        risk_note:
          limit !== null && revision.content_text.length > limit
            ? `exceeds the configured ${limit}-char limit — shorten before applying`
            : null,
        kind: required.has(sectionKey) ? 'required_fix' : 'optional_improvement',
        state: 'proposed',
        applied_at: null,
        applied_verified_snapshot_id: null,
        revision_hash: patchHash(sectionKey, revision.content_text),
      };
      patches.push(patch);
    }

    if (patches.length === 0) {
      throw new DomainError(
        'INVALID_INPUT',
        'no differences between canonical profile and the base snapshot — write canonical sections first (linkedin_profile_update)',
      );
    }

    db.run(
      "INSERT INTO change_sets (id, title, base_snapshot_id, state, created_at) VALUES (?, ?, ?, 'open', ?)",
      changeSetId,
      input.title,
      snapshot.id,
      now,
    );
    for (const p of patches) {
      db.run(
        `INSERT INTO field_patches (id, change_set_id, field_key, old_text, new_text, char_limit, char_count, char_limit_ok, claim_ids_json, rationale, risk_note, kind, state, revision_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
        p.id,
        p.change_set_id,
        p.field_key,
        p.old_text,
        p.new_text,
        p.char_limit,
        p.char_count,
        p.char_limit_ok ? 1 : 0,
        JSON.stringify(p.claim_ids),
        p.rationale,
        p.risk_note,
        p.kind,
        p.revision_hash,
        now,
        now,
      );
    }
    return getChangeSet(db, changeSetId);
  });
}

const TERMINAL_STATES = new Set(['applied', 'superseded', 'rejected']);

export function reviewPatch(
  db: SqliteDriver,
  input: {
    patch_id: string;
    action: 'accept' | 'reject' | 'edit' | 'supersede';
    new_text?: string;
    note?: string;
  },
): FieldPatch {
  return withWriteTx(db, () => {
    const row = db.get('SELECT * FROM field_patches WHERE id = ?', input.patch_id);
    if (!row) throw new DomainError('NOT_FOUND', `patch ${input.patch_id} not found`);
    const patch = rowToPatch(row);
    if (TERMINAL_STATES.has(patch.state)) {
      throw new DomainError('TERMINAL_STATE', `patch ${patch.id} is ${patch.state}`);
    }
    const now = new Date().toISOString();

    switch (input.action) {
      case 'accept':
        assertClaimsVerified(db, `patch ${patch.id} (${patch.field_key})`, patch.claim_ids);
        db.run(
          "UPDATE field_patches SET state = 'approved', updated_at = ? WHERE id = ?",
          now,
          patch.id,
        );
        break;
      case 'reject':
        db.run(
          "UPDATE field_patches SET state = 'rejected', risk_note = COALESCE(?, risk_note), updated_at = ? WHERE id = ?",
          input.note ?? null,
          now,
          patch.id,
        );
        break;
      case 'supersede':
        db.run(
          "UPDATE field_patches SET state = 'superseded', updated_at = ? WHERE id = ?",
          now,
          patch.id,
        );
        break;
      case 'edit': {
        if (!input.new_text || input.new_text.trim().length === 0) {
          throw new DomainError('INVALID_INPUT', 'edit requires new_text');
        }
        const limit = patch.char_limit;
        const ok = limit === null || input.new_text.length <= limit;
        // Re-derive the citations from the NEW text. An edit replaced the text
        // wholesale while claim_ids_json kept pointing at the claims that
        // supported the OLD text, so a patch could be exported as
        // "evidence-linked" for wording those claims never backed.
        const coverage = checkCoverage(db, {
          text: input.new_text,
          subject: 'patch',
          subject_ref: patch.id,
        });
        const supporting = [...new Set(coverage.sentences.flatMap((s) => s.claim_ids))];
        // Any edit re-hashes and drops back to 'proposed' — approvals never
        // survive content changes.
        db.run(
          `UPDATE field_patches SET new_text = ?, char_count = ?, char_limit_ok = ?, revision_hash = ?, state = 'proposed',
             claim_ids_json = ?, risk_note = ?, updated_at = ? WHERE id = ?`,
          input.new_text,
          input.new_text.length,
          ok ? 1 : 0,
          patchHash(patch.field_key, input.new_text),
          JSON.stringify(supporting),
          !ok
            ? `exceeds the configured ${limit}-char limit — shorten before applying`
            : supporting.length === 0
              ? 'edited text is not backed by any verified claim — cite evidence before applying'
              : null,
          now,
          patch.id,
        );
        break;
      }
    }
    return rowToPatch(db.get('SELECT * FROM field_patches WHERE id = ?', patch.id)!);
  });
}

export interface ExportBundleEntry {
  patch_id: string;
  field_key: string;
  kind: string;
  exact_text: string;
  char_count: number;
  char_limit: number | null;
  ui_hint: string;
}

export function exportChangeSet(
  db: SqliteDriver,
  changeSetId: string,
): { change_set_id: string; entries: ExportBundleEntry[] } {
  return withWriteTx(db, () => {
    const changeSet = getChangeSet(db, changeSetId);
    const approved = changeSet.patches.filter((p) => p.state === 'approved');
    if (approved.length === 0) {
      throw new DomainError(
        'INVALID_INPUT',
        'no approved patches to export — accept patches first',
      );
    }
    const blocked = approved.filter((p) => !p.char_limit_ok);
    if (blocked.length > 0) {
      throw new DomainError(
        'INVALID_INPUT',
        `approved patches exceed char limits: ${blocked.map((p) => p.field_key).join(', ')}`,
      );
    }
    // Last gate before text leaves for a public profile: claims can be rejected
    // between accept and export.
    for (const patch of approved) {
      assertClaimsVerified(db, `patch ${patch.id} (${patch.field_key})`, patch.claim_ids);
    }
    db.run("UPDATE change_sets SET state = 'exported' WHERE id = ?", changeSetId);
    return {
      change_set_id: changeSetId,
      entries: approved.map((p) => ({
        patch_id: p.id,
        field_key: p.field_key,
        kind: p.kind,
        exact_text: p.new_text,
        char_count: p.char_count,
        char_limit: p.char_limit,
        ui_hint: UI_HINTS[p.field_key] ?? 'apply in the matching LinkedIn profile section',
      })),
    };
  });
}

export function markPatchApplied(
  db: SqliteDriver,
  input: {
    patch_id: string;
    confirm: boolean;
    actor: 'mcp_host' | 'dashboard';
    applied_at?: string;
  },
): FieldPatch {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'marking a patch applied attests that the user pasted it into LinkedIn; pass confirm: true only after that happened',
    );
  }
  if (input.applied_at !== undefined && Number.isNaN(Date.parse(input.applied_at))) {
    throw new DomainError('INVALID_INPUT', 'applied_at must be an ISO-8601 timestamp');
  }
  return withWriteTx(db, () => {
    const row = db.get('SELECT * FROM field_patches WHERE id = ?', input.patch_id);
    if (!row) throw new DomainError('NOT_FOUND', `patch ${input.patch_id} not found`);
    const patch = rowToPatch(row);
    if (patch.state !== 'approved') {
      throw new DomainError(
        'TERMINAL_STATE',
        `only approved patches can be marked applied (patch is ${patch.state})`,
      );
    }
    const now = new Date().toISOString();
    const appliedAt = input.applied_at ?? now;
    db.run(
      "UPDATE field_patches SET state = 'applied', applied_at = ?, updated_at = ? WHERE id = ?",
      appliedAt,
      now,
      input.patch_id,
    );
    appendAuditEvent(db, {
      event_type: 'profile_patch.marked_applied',
      actor: input.actor,
      subject_type: 'field_patch',
      subject_id: input.patch_id,
      payload: { applied_at: appliedAt },
    });
    return rowToPatch(db.get('SELECT * FROM field_patches WHERE id = ?', input.patch_id)!);
  });
}

// Called after every snapshot import: applied patches whose exact text now
// appears in the fresh snapshot get their verification pointer set — closing
// the loop on manual copy/paste.
export function verifyAppliedPatches(db: SqliteDriver, snapshot: Snapshot): number {
  return withWriteTx(db, () => {
    let verified = 0;
    const applied = db.all(
      "SELECT id, field_key, new_text FROM field_patches WHERE state = 'applied' AND applied_verified_snapshot_id IS NULL",
    );
    for (const row of applied) {
      const field = snapshot.fields[String(row['field_key'])];
      if (field && field.value_text === String(row['new_text'])) {
        db.run(
          'UPDATE field_patches SET applied_verified_snapshot_id = ?, updated_at = ? WHERE id = ?',
          snapshot.id,
          new Date().toISOString(),
          String(row['id']),
        );
        verified += 1;
      }
    }
    return verified;
  });
}
