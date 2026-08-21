import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';

export type ClaimState = 'candidate' | 'verified' | 'ambiguous' | 'rejected' | 'expired';
export type ClaimMethod = 'parser' | 'model_proposed' | 'manual';
export type ClaimSensitivity = 'public' | 'internal' | 'sensitive';

export interface Claim {
  id: string;
  statement: string;
  statement_hash: string;
  state: ClaimState;
  method: ClaimMethod;
  confidence: number | null;
  limitations: string | null;
  sensitivity: ClaimSensitivity;
  review_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejected_reason: string | null;
  superseded_by: string | null;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimEvidenceRef {
  artifact_id: string;
  extraction_id?: string;
  location: Record<string, unknown>;
  role?: 'primary' | 'corroborating';
}

// Statement normalization: whitespace-collapsed, trimmed. The hash is over the
// lowercased normalization so trivially-restyled duplicates collide.
export function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim();
}

export function statementHash(statement: string): string {
  return createHash('sha256')
    .update(normalizeStatement(statement).toLowerCase(), 'utf8')
    .digest('hex');
}

// Anything that reads like personal credit must not be backed by a
// local_clone_reference source (blender_mcp is a clone of someone else's repo —
// familiarity evidence, never authorship evidence).
//
// This list is the "not even with an acknowledgement" tier, not the whole
// defence. A word list cannot be trusted to recognise every way of claiming
// credit — "Creator of X", "Lead maintainer of X", "Rewrote the scheduler" and
// "Ported X to Y" all slipped past the original verb list — so verifyClaim
// additionally requires an explicit human assertion for ANY clone-backed claim.
// That makes the gap in this regex non-fatal: the worst case is a claim that
// needs one extra deliberate step, not one that passes silently.
const FIRST_PERSON = ['i', 'my', 'me', 'mine', 'our', 'ours', 'we'];
// Credit verbs, including the prefixed and past forms the original list missed
// ("rewrote" is not caught by \bwrote\b, "maintainer" is not caught by
// \bmaintain(ed|s)?\b).
const CREDIT_VERBS = [
  'built',
  'created',
  'authored',
  'co-authored',
  'developed',
  'designed',
  'implemented',
  'wrote',
  'rewrote',
  'shipped',
  'launched',
  'founded',
  'invented',
  'architected',
  'engineered',
  'refactored',
  'ported',
  'maintained',
  'maintains',
  'maintain',
  'maintaining',
  'contributed',
  'own',
  'owns',
  'owned',
];
// Agent nouns: "Creator of X", "Lead maintainer of X", "Author of X".
const CREDIT_NOUNS = ['creator', 'author', 'owner', 'founder', 'maintainer', 'architect'];

const AUTHORSHIP_SHAPED = new RegExp(
  `\\b(?:${[...FIRST_PERSON, ...CREDIT_VERBS, ...CREDIT_NOUNS].join('|')})\\b`,
  'i',
);

export function isAuthorshipShaped(statement: string): boolean {
  return AUTHORSHIP_SHAPED.test(statement);
}

// Travels with the claim so the constraint reaches every patch and draft that
// cites it, not just the moment of verification.
const CLONE_LIMITATION =
  'familiarity only: the primary evidence is a local clone of third-party code, not authorship';

function rowToClaim(row: Record<string, unknown>): Claim {
  return {
    id: String(row['id']),
    statement: String(row['statement']),
    statement_hash: String(row['statement_hash']),
    state: String(row['state']) as ClaimState,
    method: String(row['method']) as ClaimMethod,
    confidence: row['confidence'] === null ? null : Number(row['confidence']),
    limitations: (row['limitations'] as string | null) ?? null,
    sensitivity: String(row['sensitivity']) as ClaimSensitivity,
    review_by: (row['review_by'] as string | null) ?? null,
    reviewed_by: (row['reviewed_by'] as string | null) ?? null,
    reviewed_at: (row['reviewed_at'] as string | null) ?? null,
    rejected_reason: (row['rejected_reason'] as string | null) ?? null,
    superseded_by: (row['superseded_by'] as string | null) ?? null,
    merged_into: (row['merged_into'] as string | null) ?? null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

export function getClaim(db: SqliteDriver, id: string): Claim {
  const row = db.get('SELECT * FROM claims WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `claim ${id} not found`);
  return rowToClaim(row);
}

export interface ProposeClaimInput {
  statement: string;
  evidence: ClaimEvidenceRef[];
  method: ClaimMethod;
  confidence?: number;
  limitations?: string;
  sensitivity?: ClaimSensitivity;
  review_by?: string;
}

export function proposeClaim(db: SqliteDriver, input: ProposeClaimInput): Claim {
  const statement = normalizeStatement(input.statement);
  if (statement.length < 8 || statement.length > 500) {
    throw new DomainError('INVALID_INPUT', 'claim statements must be 8-500 characters');
  }
  if (input.evidence.length === 0) {
    throw new DomainError('INVALID_INPUT', 'a claim needs at least one evidence reference');
  }
  const hash = statementHash(statement);

  return withWriteTx(db, () => {
    // Keyed on rejected_reason as well as state, deliberately. A rejection is
    // permanent, but `state` is a mutable column that several lifecycle calls
    // write; keying the tombstone on state alone means any one of them moving a
    // row out of 'rejected' silently reopens the door. rejected_reason is only
    // ever written by rejectClaim and is never cleared, so it is the durable
    // half of the tombstone.
    const tombstone = db.get(
      "SELECT id, rejected_reason FROM claims WHERE statement_hash = ? AND (state = 'rejected' OR rejected_reason IS NOT NULL)",
      hash,
    );
    if (tombstone) {
      throw new DomainError(
        'CLAIM_REJECTED_TOMBSTONE',
        `an identical claim was previously rejected (${String(tombstone['id'])}: ${String(tombstone['rejected_reason'] ?? 'no reason recorded')}); it cannot be resurrected by re-proposing`,
      );
    }
    const active = db.get(
      "SELECT id FROM claims WHERE statement_hash = ? AND state IN ('candidate','verified','ambiguous')",
      hash,
    );
    if (active) {
      throw new DomainError(
        'INVALID_INPUT',
        `an active claim with this statement already exists (${String(active['id'])})`,
      );
    }

    const now = new Date().toISOString();
    const claim: Claim = {
      id: newId('clm'),
      statement,
      statement_hash: hash,
      state: 'candidate',
      method: input.method,
      confidence: input.confidence ?? null,
      limitations: input.limitations ?? null,
      sensitivity: input.sensitivity ?? 'public',
      review_by: input.review_by ?? null,
      reviewed_by: null,
      reviewed_at: null,
      rejected_reason: null,
      superseded_by: null,
      merged_into: null,
      created_at: now,
      updated_at: now,
    };
    db.run(
      `INSERT INTO claims (id, statement, statement_hash, state, method, confidence, limitations, sensitivity, review_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      claim.id,
      claim.statement,
      claim.statement_hash,
      claim.state,
      claim.method,
      claim.confidence,
      claim.limitations,
      claim.sensitivity,
      claim.review_by,
      now,
      now,
    );
    for (const ev of input.evidence) {
      const artifact = db.get('SELECT id FROM artifacts WHERE id = ?', ev.artifact_id);
      if (!artifact) {
        throw new DomainError('NOT_FOUND', `evidence artifact ${ev.artifact_id} not found`);
      }
      db.run(
        `INSERT INTO claim_evidence (claim_id, artifact_id, extraction_id, location_json, role)
         VALUES (?, ?, ?, ?, ?)`,
        claim.id,
        ev.artifact_id,
        ev.extraction_id ?? null,
        JSON.stringify(ev.location ?? {}),
        ev.role ?? 'primary',
      );
    }
    return claim;
  });
}

function touch(db: SqliteDriver, id: string): void {
  db.run('UPDATE claims SET updated_at = ? WHERE id = ?', new Date().toISOString(), id);
}

export function verifyClaim(
  db: SqliteDriver,
  input: {
    claim_id: string;
    confirm: boolean;
    limitations?: string;
    note?: string;
    reviewer?: string;
    review_by?: string | null;
    /**
     * Required when the claim's primary evidence is a local_clone_reference
     * source. Asserts that the statement describes familiarity with third-party
     * code rather than authorship of it; the assertion is written into the
     * claim's limitations so it travels with every patch and draft that cites it.
     */
    clone_reference_ack?: boolean;
  },
): Claim {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'verification is a human decision: pass confirm: true only after the user has reviewed the evidence',
    );
  }
  return withWriteTx(db, () => {
    const claim = getClaim(db, input.claim_id);
    if (claim.state === 'rejected') {
      throw new DomainError(
        'CLAIM_REJECTED_TOMBSTONE',
        `claim ${claim.id} is a rejected tombstone`,
      );
    }
    // A merged claim's evidence now lives on the target. Verifying it would put
    // a duplicate statement back in the live corpus while merged_into still
    // points elsewhere, so the same fact would be citable under two ids.
    if (claim.merged_into !== null) {
      throw new DomainError(
        'TERMINAL_STATE',
        `claim ${claim.id} was merged into ${claim.merged_into}; verify that claim instead`,
      );
    }
    if (claim.state === 'verified') return claim;

    const primary = db.all(
      `SELECT ce.artifact_id, s.trust
       FROM claim_evidence ce
       JOIN artifacts a ON a.id = ce.artifact_id
       JOIN sources s ON s.id = a.source_id
       WHERE ce.claim_id = ? AND ce.role = 'primary'`,
      claim.id,
    );
    if (primary.length === 0) {
      throw new DomainError(
        'EVIDENCE_NOT_VERIFIED',
        `claim ${claim.id} has no primary evidence link; attach one before verifying`,
      );
    }
    const clonePrimary = primary.some((row) => String(row['trust']) === 'local_clone_reference');
    if (clonePrimary) {
      // Tier 1 — blatant credit language. No acknowledgement can make "I built
      // it" true of someone else's repository, so there is no override here.
      if (isAuthorshipShaped(claim.statement)) {
        throw new DomainError(
          'EVIDENCE_NOT_VERIFIED',
          `claim ${claim.id} reads as personal credit but its primary evidence is a local_clone_reference source (third-party code). Clones can evidence familiarity, never authorship — rephrase the statement to describe what you know about the code rather than what you did to it.`,
          { blockers: ['authorship_on_clone_evidence'] },
        );
      }
      // Tier 2 — everything else. The regex above cannot be trusted to catch
      // every phrasing, so the default for clone-backed evidence is refusal and
      // the member has to state the intent explicitly. Fail-closed beats a
      // cleverer word list.
      if (input.clone_reference_ack !== true) {
        throw new DomainError(
          'EVIDENCE_NOT_VERIFIED',
          `claim ${claim.id}'s primary evidence is a local_clone_reference source (a clone of code you did not write). No word list can reliably tell a familiarity claim from a credit claim, so this needs an explicit decision: re-verify with clone_reference_ack: true to assert that this statement describes familiarity with the code, not authorship of it. The assertion is recorded in the claim's limitations.`,
          { blockers: ['clone_reference_ack_required'] },
        );
      }
    }

    const now = new Date().toISOString();
    // The retention sweep expires any verified claim whose review_by has passed,
    // and it runs at every process boot. Nothing used to write review_by after
    // the initial propose, so re-reviewing an already-expired claim could never
    // be persisted: verify -> next boot -> expired -> forever.
    //
    // Only the re-review case clears the date. Verifying a fresh candidate must
    // leave review_by alone even when it is already in the past — that is a
    // deliberate 'stale on arrival' claim, and clearing it here would disable
    // the freshness sweep entirely. An explicitly supplied date always wins,
    // including a past one.
    // The acknowledgement becomes a permanent wording constraint, not just a
    // gate that was passed once.
    const limitations =
      clonePrimary && !(claim.limitations ?? '').includes(CLONE_LIMITATION)
        ? [input.limitations ?? claim.limitations, CLONE_LIMITATION].filter(Boolean).join(' — ')
        : (input.limitations ?? null);

    const supplied = input.review_by;
    let reviewBy = supplied !== undefined ? supplied : claim.review_by;
    if (
      supplied === undefined &&
      claim.state === 'expired' &&
      reviewBy !== null &&
      reviewBy < now
    ) {
      reviewBy = null;
    }

    db.run(
      `UPDATE claims SET state = 'verified', limitations = COALESCE(?, limitations),
       review_by = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      limitations,
      reviewBy,
      input.reviewer ?? 'user',
      now,
      now,
      claim.id,
    );
    return getClaim(db, claim.id);
  });
}

export function rejectClaim(
  db: SqliteDriver,
  input: { claim_id: string; reason: string; confirm: boolean; reviewer: string },
): Claim {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'rejection is a human decision: pass confirm: true only after the user has reviewed the evidence',
    );
  }
  if (!input.reason || input.reason.trim().length < 3) {
    throw new DomainError(
      'INVALID_INPUT',
      'rejection requires a reason (it becomes the permanent tombstone)',
    );
  }
  return withWriteTx(db, () => {
    const claim = getClaim(db, input.claim_id);
    const now = new Date().toISOString();
    db.run(
      `UPDATE claims SET state = 'rejected', rejected_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`,
      input.reason.trim(),
      input.reviewer,
      now,
      now,
      claim.id,
    );
    return getClaim(db, claim.id);
  });
}

// Allowed-wording constraints change as conflicts get resolved (e.g. "do not
// publish until reconciled" -> "CV is authoritative"). Amending them is a
// human decision that never changes the statement or the claim's state.
export function amendClaimLimitations(
  db: SqliteDriver,
  input: { claim_id: string; limitations: string | null; reviewer?: string },
): Claim {
  return withWriteTx(db, () => {
    const claim = getClaim(db, input.claim_id);
    if (claim.state === 'rejected') {
      throw new DomainError(
        'TERMINAL_STATE',
        'rejected claims are tombstones and cannot be amended',
      );
    }
    const now = new Date().toISOString();
    db.run(
      'UPDATE claims SET limitations = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      input.limitations,
      input.reviewer ?? 'user',
      now,
      now,
      claim.id,
    );
    return getClaim(db, claim.id);
  });
}

export function markClaimAmbiguous(
  db: SqliteDriver,
  input: { claim_id: string; confirm: boolean; reviewer: string; note?: string },
): Claim {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'marking a claim ambiguous is a human decision: pass confirm: true after review',
    );
  }
  return withWriteTx(db, () => {
    const claim = getClaim(db, input.claim_id);
    if (claim.state === 'rejected') {
      throw new DomainError('TERMINAL_STATE', 'rejected claims stay rejected');
    }
    if (claim.merged_into !== null) {
      throw new DomainError(
        'TERMINAL_STATE',
        `claim ${claim.id} was merged into ${claim.merged_into}; act on that claim instead`,
      );
    }
    const now = new Date().toISOString();
    db.run(
      `UPDATE claims SET state = 'ambiguous', limitations = COALESCE(?, limitations),
       reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      input.note ?? null,
      input.reviewer,
      now,
      now,
      input.claim_id,
    );
    return getClaim(db, input.claim_id);
  });
}

export function mergeClaim(
  db: SqliteDriver,
  input: { claim_id: string; merge_into: string; confirm: boolean; reviewer: string },
): Claim {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'merging claims is a human decision: pass confirm: true after comparing both claims and evidence',
    );
  }
  return withWriteTx(db, () => {
    const claim = getClaim(db, input.claim_id);
    const target = getClaim(db, input.merge_into);
    if (claim.id === target.id) {
      throw new DomainError('INVALID_INPUT', 'cannot merge a claim into itself');
    }
    // Merge was the one lifecycle call missing this guard, and it writes
    // state = 'expired'. That moved a tombstone out of 'rejected' and let the
    // identical statement be re-proposed and verified — a rejected claim back
    // in the corpus, eligible for patches and drafts.
    if (claim.state === 'rejected') {
      throw new DomainError(
        'TERMINAL_STATE',
        'rejected claims are tombstones and cannot be merged',
      );
    }
    if (target.state === 'rejected') {
      throw new DomainError('TERMINAL_STATE', 'cannot merge a claim into a rejected tombstone');
    }
    db.run(
      `UPDATE claims SET state = 'expired', merged_into = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      target.id,
      input.reviewer,
      new Date().toISOString(),
      new Date().toISOString(),
      claim.id,
    );
    // Evidence follows the merge as corroboration.
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.run(
      `INSERT OR IGNORE INTO claim_evidence (claim_id, artifact_id, extraction_id, location_json, role)
       SELECT ?, artifact_id, extraction_id, location_json, 'corroborating' FROM claim_evidence WHERE claim_id = ?`,
      target.id,
      claim.id,
    );
    touch(db, target.id);
    return getClaim(db, claim.id);
  });
}

export interface ClaimListFilters {
  state?: ClaimState;
  stale?: boolean;
  q?: string;
  artifact_id?: string;
  sensitivity?: ClaimSensitivity;
}

export function listClaims(
  db: SqliteDriver,
  filters: ClaimListFilters,
  fts5Available: boolean,
): Claim[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.state) {
    clauses.push('c.state = ?');
    params.push(filters.state);
  }
  if (filters.stale) {
    clauses.push("c.state = 'verified' AND c.review_by IS NOT NULL AND c.review_by < ?");
    params.push(new Date().toISOString());
  }
  if (filters.sensitivity) {
    clauses.push('c.sensitivity = ?');
    params.push(filters.sensitivity);
  }
  if (filters.artifact_id) {
    clauses.push('c.id IN (SELECT claim_id FROM claim_evidence WHERE artifact_id = ?)');
    params.push(filters.artifact_id);
  }
  if (filters.q) {
    const ids = searchClaimIds(db, filters.q, fts5Available);
    if (ids.length === 0) return [];
    clauses.push(`c.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .all(`SELECT c.* FROM claims c ${where} ORDER BY c.created_at, c.id`, ...params)
    .map(rowToClaim);
}

function searchClaimIds(db: SqliteDriver, q: string, fts5Available: boolean): string[] {
  if (fts5Available) {
    try {
      const escaped = `"${q.replaceAll('"', '""')}"`;
      return db
        .all(
          `SELECT c.id FROM claims_fts f JOIN claims c ON c.rowid = f.rowid WHERE claims_fts MATCH ?`,
          escaped,
        )
        .map((r) => String(r['id']));
    } catch {
      // fall through
    }
  }
  return db
    .all(
      `SELECT id FROM claims WHERE statement LIKE ? ESCAPE '\\'`,
      `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
    )
    .map((r) => String(r['id']));
}

export interface ClaimEvidenceDetail {
  artifact_id: string;
  source_relpath: string;
  source_label: string;
  source_trust: string;
  location: Record<string, unknown>;
  role: string;
}

export function getClaimEvidence(db: SqliteDriver, claimId: string): ClaimEvidenceDetail[] {
  return db
    .all(
      `SELECT ce.artifact_id, ce.location_json, ce.role, a.source_relpath, s.label AS source_label, s.trust AS source_trust
       FROM claim_evidence ce
       JOIN artifacts a ON a.id = ce.artifact_id
       JOIN sources s ON s.id = a.source_id
       WHERE ce.claim_id = ?`,
      claimId,
    )
    .map((row) => ({
      artifact_id: String(row['artifact_id']),
      source_relpath: String(row['source_relpath']),
      source_label: String(row['source_label']),
      source_trust: String(row['source_trust']),
      location: JSON.parse(String(row['location_json'])) as Record<string, unknown>,
      role: String(row['role']),
    }));
}
