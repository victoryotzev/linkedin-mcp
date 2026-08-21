import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { appendAuditEvent, requireIntactChain } from './auditService.ts';
import type { HumanActor } from './auditService.ts';
import { corpusFingerprint } from './coverageService.ts';
import { currentRevision, getDraft, revisionByHash } from './draftService.ts';
import { latestValidation } from './validationService.ts';

// Revision-bound, single-use approvals.
//
// Publication decisions always require an explicit human confirmation. The
// dashboard and control CLI collect it directly; the MCP decision tool binds it
// to the approval id and exact revision hash before calling these functions.

export type ApprovalState =
  | 'pending'
  | 'granted'
  | 'consumed'
  | 'invalidated'
  | 'expired'
  | 'denied';
export type ApprovalDecisionActor = 'mcp_host' | HumanActor;

export interface Approval {
  id: string;
  action: 'publish_post';
  draft_id: string;
  revision_hash: string;
  content_hash: string;
  account_id: string;
  visibility: string;
  media_hashes: string[];
  intended_time: string | null;
  state: ApprovalState;
  requested_by: 'mcp_host' | 'dashboard';
  granted_at: string | null;
  consumed_at: string | null;
  expires_at: string;
  invalidated_by: string | null;
  created_at: string;
}

const DEFAULT_TTL_HOURS = 72;

function rowToApproval(row: Record<string, unknown>): Approval {
  return {
    id: String(row['id']),
    action: 'publish_post',
    draft_id: String(row['draft_id']),
    revision_hash: String(row['revision_hash']),
    content_hash: String(row['content_hash']),
    account_id: String(row['account_id']),
    visibility: String(row['visibility']),
    media_hashes: JSON.parse(String(row['media_hashes_json'])) as string[],
    intended_time: (row['intended_time'] as string | null) ?? null,
    state: String(row['state']) as ApprovalState,
    requested_by: String(row['requested_by']) as 'mcp_host' | 'dashboard',
    granted_at: (row['granted_at'] as string | null) ?? null,
    consumed_at: (row['consumed_at'] as string | null) ?? null,
    expires_at: String(row['expires_at']),
    invalidated_by: (row['invalidated_by'] as string | null) ?? null,
    created_at: String(row['created_at']),
  };
}

export function getApproval(db: SqliteDriver, id: string): Approval {
  const row = db.get('SELECT * FROM approvals WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `approval ${id} not found`);
  return rowToApproval(row);
}

export function ensureLocalAccount(db: SqliteDriver, label = 'primary LinkedIn account'): string {
  return withWriteTx(db, () => {
    // Publication approvals must bind to the write-lane identity whenever it
    // exists. Selecting the oldest account silently bound new approvals to the
    // DMA/read lane on installations that configured read access first.
    const existing = db.get(
      "SELECT id FROM linkedin_accounts ORDER BY CASE WHEN lane = 'write' THEN 0 ELSE 1 END, created_at",
    );
    if (existing) return String(existing['id']);
    const id = newId('acc');
    db.run(
      "INSERT INTO linkedin_accounts (id, label, status, created_at) VALUES (?, ?, 'unverified', ?)",
      id,
      label,
      new Date().toISOString(),
    );
    return id;
  });
}

export interface ApprovalPreview {
  draft_id: string;
  revision_hash: string;
  body_text: string;
  visibility: string;
  media: Array<{ artifact_id: string; alt: string }>;
  char_count: number;
  account_id: string;
  intended_time: string | null;
  /**
   * False when the draft has moved on since this approval was requested. The
   * preview always shows the BOUND revision — the bytes that would actually be
   * published — so this flag tells the reviewer that the draft they are editing
   * is no longer the one under approval.
   */
  revision_is_current: boolean;
}

export function requestApproval(
  db: SqliteDriver,
  input: {
    draft_id: string;
    account_id?: string;
    intended_time?: string;
    requested_by?: 'mcp_host' | 'dashboard';
    ttl_hours?: number;
  },
): { approval: Approval; preview: ApprovalPreview } {
  requireIntactChain(db);
  const accountId = input.account_id ?? ensureLocalAccount(db);

  return withWriteTx(db, () => {
    // Every read that the approval binds to happens INSIDE this transaction.
    // BEGIN IMMEDIATE holds the write lock, so no other process can append a
    // revision, invalidate the validation report, or change a claim's state
    // between the checks below and the INSERT — which was possible when these
    // reads sat outside, and would have minted an approval bound to a revision
    // that was already superseded.
    const draft = getDraft(db, input.draft_id);
    const revision = currentRevision(db, input.draft_id);

    const validation = latestValidation(db, input.draft_id);
    if (!validation || !validation.passed || validation.revision_hash !== revision.revision_hash) {
      throw new DomainError(
        'EVIDENCE_NOT_VERIFIED',
        `draft ${draft.id} must pass linkedin_draft_validate on its current revision before approval can be requested`,
        { blockers: ['draft_not_validated'] },
      );
    }
    // The text can be unchanged while the evidence under it is withdrawn. The
    // report's unsupported_claims check is a statement about the verified-claim
    // corpus, so comparing revision hashes alone let a member reject the sole
    // backing claim as false and still open the approval gate on the cached pass.
    const fingerprint = corpusFingerprint(db);
    if (validation.corpus_fingerprint !== fingerprint) {
      throw new DomainError(
        'EVIDENCE_NOT_VERIFIED',
        `draft ${draft.id} was validated against a different evidence corpus (claims have been verified, rejected or expired since); re-run linkedin_draft_validate before requesting approval`,
        { blockers: ['validation_corpus_stale'] },
      );
    }

    const live = db.get(
      "SELECT id, state FROM approvals WHERE draft_id = ? AND state IN ('pending','granted')",
      draft.id,
    );
    if (live) {
      throw new DomainError(
        'INVALID_INPUT',
        `draft ${draft.id} already has a live approval (${String(live['id'])}, ${String(live['state'])})`,
      );
    }
    const now = new Date();
    const approval: Approval = {
      id: newId('apv'),
      action: 'publish_post',
      draft_id: draft.id,
      revision_hash: revision.revision_hash,
      content_hash: revision.revision_hash,
      account_id: accountId,
      visibility: revision.visibility,
      media_hashes: revision.media.map((m) => m.artifact_id),
      intended_time: input.intended_time ?? null,
      state: 'pending',
      requested_by: input.requested_by ?? 'mcp_host',
      granted_at: null,
      consumed_at: null,
      expires_at: new Date(
        now.getTime() + (input.ttl_hours ?? DEFAULT_TTL_HOURS) * 3600_000,
      ).toISOString(),
      invalidated_by: null,
      created_at: now.toISOString(),
    };
    db.run(
      `INSERT INTO approvals (id, action, draft_id, revision_hash, content_hash, account_id, visibility, media_hashes_json, intended_time, state, requested_by, expires_at, created_at)
       VALUES (?, 'publish_post', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      approval.id,
      approval.draft_id,
      approval.revision_hash,
      approval.content_hash,
      approval.account_id,
      approval.visibility,
      JSON.stringify(approval.media_hashes),
      approval.intended_time,
      approval.requested_by,
      approval.expires_at,
      approval.created_at,
    );
    appendAuditEvent(db, {
      event_type: 'approval.requested',
      actor: approval.requested_by,
      subject_type: 'approval',
      subject_id: approval.id,
      payload: {
        draft_id: approval.draft_id,
        revision_hash: approval.revision_hash,
        visibility: approval.visibility,
        account_id: approval.account_id,
      },
    });
    return {
      approval,
      preview: {
        draft_id: draft.id,
        revision_hash: revision.revision_hash,
        body_text: revision.body_text,
        visibility: revision.visibility,
        media: revision.media,
        char_count: revision.body_text.length,
        account_id: accountId,
        intended_time: approval.intended_time,
        // The approval was just minted from this very revision.
        revision_is_current: true,
      },
    };
  });
}

// HUMAN-CONFIRMED CONTROL ONLY. Callers must collect confirmation before this
// transition. The MCP tool additionally binds that confirmation to the exact
// approval id and revision hash.
export function grantApproval(
  db: SqliteDriver,
  approvalId: string,
  actor: ApprovalDecisionActor = 'dashboard',
): Approval {
  requireIntactChain(db);
  return withWriteTx(db, () => {
    const approval = getApproval(db, approvalId);
    if (approval.state !== 'pending') {
      throw new DomainError('TERMINAL_STATE', `approval ${approvalId} is ${approval.state}`);
    }
    const revision = currentRevision(db, approval.draft_id);
    if (revision.revision_hash !== approval.revision_hash) {
      // No invalidation write here: it sits inside this withWriteTx and the
      // throw below rolls it back, so it never persisted. It is also
      // redundant — appendRevision (draftService.ts) invalidates live approvals
      // in a transaction that commits, which is what makes this branch
      // unreachable in normal operation. Reaching it means a revision was
      // written without going through appendRevision; refusing is the whole
      // job, and the boot sweep expires the stale row at its TTL.
      throw new DomainError(
        'APPROVAL_INVALIDATED',
        'the draft changed after this approval was requested; request a fresh approval for the current revision',
      );
    }
    const now = new Date().toISOString();
    db.run("UPDATE approvals SET state = 'granted', granted_at = ? WHERE id = ?", now, approvalId);
    appendAuditEvent(db, {
      event_type: 'approval.granted',
      actor,
      subject_type: 'approval',
      subject_id: approvalId,
      payload: { draft_id: approval.draft_id, revision_hash: approval.revision_hash },
    });
    return getApproval(db, approvalId);
  });
}

export function denyApproval(
  db: SqliteDriver,
  approvalId: string,
  reason: string,
  actor: ApprovalDecisionActor = 'dashboard',
): Approval {
  return withWriteTx(db, () => {
    const approval = getApproval(db, approvalId);
    if (approval.state !== 'pending') {
      throw new DomainError('TERMINAL_STATE', `approval ${approvalId} is ${approval.state}`);
    }
    db.run(
      "UPDATE approvals SET state = 'denied', invalidated_by = ? WHERE id = ?",
      reason,
      approvalId,
    );
    appendAuditEvent(db, {
      event_type: 'approval.denied',
      actor,
      subject_type: 'approval',
      subject_id: approvalId,
      payload: { reason },
    });
    return getApproval(db, approvalId);
  });
}

// Called whenever a draft gains a revision: an approval describes one exact
// text, so any edit kills it.
export function invalidateApprovalsForDraft(
  db: SqliteDriver,
  draftId: string,
  reason: string,
): number {
  return withWriteTx(db, () => {
    const live = db.all(
      "SELECT id FROM approvals WHERE draft_id = ? AND state IN ('pending','granted')",
      draftId,
    );
    for (const row of live) {
      db.run(
        "UPDATE approvals SET state = 'invalidated', invalidated_by = ? WHERE id = ?",
        reason,
        String(row['id']),
      );
      appendAuditEvent(db, {
        event_type: 'approval.invalidated',
        actor: 'system',
        subject_type: 'approval',
        subject_id: String(row['id']),
        payload: { draft_id: draftId, reason },
      });
    }
    return live.length;
  });
}

export function listApprovals(db: SqliteDriver, state?: ApprovalState): Approval[] {
  const rows = state
    ? db.all('SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC', state)
    : db.all('SELECT * FROM approvals ORDER BY created_at DESC');
  return rows.map(rowToApproval);
}

export function approvalPreview(db: SqliteDriver, approvalId: string): ApprovalPreview {
  const approval = getApproval(db, approvalId);
  // The BOUND revision, not the current one. Rendering current text under the
  // bound hash meant the human could approve bytes that are not the bytes the
  // approval authorises — the exact substitution the revision binding exists to
  // prevent. Revisions are append-only, so the bound one is always retrievable.
  const bound = revisionByHash(db, approval.draft_id, approval.revision_hash);
  if (!bound) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `approval ${approval.id} is bound to revision ${approval.revision_hash}, which is not in the draft's history; refusing to preview a substitute`,
      { blockers: ['bound_revision_missing'] },
    );
  }
  const current = currentRevision(db, approval.draft_id);
  return {
    draft_id: approval.draft_id,
    revision_hash: approval.revision_hash,
    body_text: bound.body_text,
    visibility: approval.visibility,
    media: bound.media,
    char_count: bound.body_text.length,
    account_id: approval.account_id,
    intended_time: approval.intended_time,
    revision_is_current: current.revision_hash === approval.revision_hash,
  };
}

export function idempotencyKeyFor(approval: Approval): string {
  return createHash('sha256')
    .update(`${approval.id}|${approval.content_hash}|${approval.account_id}`, 'utf8')
    .digest('hex');
}
