import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { markClaimAmbiguous, rejectClaim, verifyClaim, type Claim } from './claimService.ts';

export type ConflictType = 'contradiction' | 'duplication' | 'freshness' | 'scope';
export type ConflictState = 'open' | 'resolved' | 'dismissed';

export interface Conflict {
  id: string;
  type: ConflictType;
  state: ConflictState;
  resolution_note: string | null;
  created_at: string;
  members: Array<{ claim_id: string; statement: string; state: string }>;
}

// Deterministic detection. A claim's "metric signature" is its normalized
// statement with every number replaced by '#': two active claims sharing a
// signature but differing in the numbers contradict each other (e.g.
// "project has 187 test files" vs "project has 203 test files").
export function metricSignature(statement: string): string | null {
  if (!/\d/.test(statement)) return null;
  return statement
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .trim();
}

export function detectConflicts(db: SqliteDriver): { created: string[] } {
  const created: string[] = [];
  const active = db.all(
    "SELECT id, statement FROM claims WHERE state IN ('candidate','verified','ambiguous')",
  );
  const bySignature = new Map<string, Array<{ id: string; statement: string }>>();
  for (const row of active) {
    const sig = metricSignature(String(row['statement']));
    if (!sig) continue;
    const group = bySignature.get(sig) ?? [];
    group.push({ id: String(row['id']), statement: String(row['statement']) });
    bySignature.set(sig, group);
  }

  withWriteTx(db, () => {
    for (const group of bySignature.values()) {
      if (group.length < 2) continue;
      const distinct = new Set(group.map((g) => g.statement.toLowerCase()));
      if (distinct.size < 2) continue;
      const ids = group.map((g) => g.id).sort();
      // Skip if an open conflict already covers exactly these members.
      const existing = db.get(
        `SELECT cc.id FROM claim_conflicts cc WHERE cc.state = 'open' AND cc.type = 'contradiction'
         AND (SELECT GROUP_CONCAT(claim_id) FROM (SELECT claim_id FROM claim_conflict_members WHERE conflict_id = cc.id ORDER BY claim_id)) = ?`,
        ids.join(','),
      );
      if (existing) continue;
      const conflictId = newId('cfl');
      db.run(
        "INSERT INTO claim_conflicts (id, type, state, created_at) VALUES (?, 'contradiction', 'open', ?)",
        conflictId,
        new Date().toISOString(),
      );
      for (const id of ids) {
        db.run(
          'INSERT INTO claim_conflict_members (conflict_id, claim_id) VALUES (?, ?)',
          conflictId,
          id,
        );
      }
      created.push(conflictId);
    }
  });
  return { created };
}

function rowToConflict(db: SqliteDriver, row: Record<string, unknown>): Conflict {
  const members = db
    .all(
      `SELECT m.claim_id, c.statement, c.state FROM claim_conflict_members m
       JOIN claims c ON c.id = m.claim_id WHERE m.conflict_id = ? ORDER BY m.claim_id`,
      String(row['id']),
    )
    .map((m) => ({
      claim_id: String(m['claim_id']),
      statement: String(m['statement']),
      state: String(m['state']),
    }));
  return {
    id: String(row['id']),
    type: String(row['type']) as ConflictType,
    state: String(row['state']) as ConflictState,
    resolution_note: (row['resolution_note'] as string | null) ?? null,
    created_at: String(row['created_at']),
    members,
  };
}

export function listConflicts(
  db: SqliteDriver,
  filters: { state?: ConflictState; type?: ConflictType } = {},
): Conflict[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.state) {
    clauses.push('state = ?');
    params.push(filters.state);
  }
  if (filters.type) {
    clauses.push('type = ?');
    params.push(filters.type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .all(`SELECT * FROM claim_conflicts ${where} ORDER BY created_at`, ...params)
    .map((row) => rowToConflict(db, row));
}

export interface MemberAction {
  claim_id: string;
  action: 'verify' | 'reject' | 'mark_ambiguous';
  reason?: string;
}

// Material conflicts require human resolution: the resolver applies member
// transitions atomically — if any transition is invalid, the whole resolution
// rolls back and the conflict stays open.
export function resolveConflict(
  db: SqliteDriver,
  input: {
    conflict_id: string;
    resolution: 'resolved' | 'dismissed';
    note: string;
    member_actions?: MemberAction[];
    confirm: boolean;
    reviewer?: string;
  },
): Conflict {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'conflict resolution is a human decision: pass confirm: true',
    );
  }
  return withWriteTx(db, () => {
    const row = db.get('SELECT * FROM claim_conflicts WHERE id = ?', input.conflict_id);
    if (!row) throw new DomainError('NOT_FOUND', `conflict ${input.conflict_id} not found`);
    if (String(row['state']) !== 'open') {
      throw new DomainError(
        'TERMINAL_STATE',
        `conflict ${input.conflict_id} is already ${String(row['state'])}`,
      );
    }
    const members = db
      .all('SELECT claim_id FROM claim_conflict_members WHERE conflict_id = ?', input.conflict_id)
      .map((m) => String(m['claim_id']));
    const actions = input.member_actions ?? [];

    // Resolving means deciding: every member claim must get a disposition.
    // Without this, a conflict could be closed while both contradictory
    // claims stayed verified — which is exactly what happened before.
    if (input.resolution === 'resolved') {
      const decided = new Set(actions.map((a) => a.claim_id));
      const undecided = members.filter((id) => !decided.has(id));
      if (undecided.length > 0) {
        throw new DomainError(
          'INVALID_INPUT',
          `resolving a conflict requires a decision for every member claim; missing: ${undecided.join(', ')}. Use 'dismissed' if the members do not actually conflict.`,
          { blockers: undecided.map((id) => `undecided:${id}`) },
        );
      }
      if (!actions.some((a) => a.action === 'verify')) {
        // A contradiction where nothing survives is legitimate (both wrong),
        // but it should be deliberate, so only warn via the audit note below.
      }
    }

    // Applies to BOTH resolutions. This check used to live inside the
    // 'resolved' branch, so dismissing a conflict could verify or reject any
    // claim in the ledger by naming it in member_actions — a conflict the
    // member says is not a conflict became a way to act on unrelated claims.
    const foreign = actions.filter((a) => !members.includes(a.claim_id));
    if (foreign.length > 0) {
      throw new DomainError(
        'INVALID_INPUT',
        `member_actions reference claims outside this conflict: ${foreign.map((a) => a.claim_id).join(', ')}`,
      );
    }

    const reviewer = input.reviewer ?? 'user:dashboard';
    for (const action of actions) {
      applyMemberAction(db, action, reviewer);
    }
    db.run(
      `UPDATE claim_conflicts SET state = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
      input.resolution,
      input.note,
      reviewer,
      new Date().toISOString(),
      input.conflict_id,
    );
    const updated = db.get('SELECT * FROM claim_conflicts WHERE id = ?', input.conflict_id);
    return rowToConflict(db, updated!);
  });
}

// No default branch: MemberAction.action is a closed union and every arm
// decides something. A fallback that returned the claim untouched would make a
// typo in a new action look like a decision that changed nothing.
function applyMemberAction(db: SqliteDriver, action: MemberAction, reviewer: string): Claim {
  switch (action.action) {
    case 'verify':
      return verifyClaim(db, { claim_id: action.claim_id, confirm: true, reviewer });
    case 'reject':
      return rejectClaim(db, {
        claim_id: action.claim_id,
        reason: action.reason ?? 'rejected during conflict resolution',
        confirm: true,
        reviewer,
      });
    case 'mark_ambiguous':
      return markClaimAmbiguous(db, {
        claim_id: action.claim_id,
        confirm: true,
        reviewer,
        ...(action.reason !== undefined ? { note: action.reason } : {}),
      });
  }
}
