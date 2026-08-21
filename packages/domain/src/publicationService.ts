import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import type { Publisher } from '@linkedin-mcp/linkedin';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { getApproval, idempotencyKeyFor, type Approval } from './approvalService.ts';
import { appendAuditEvent, requireIntactChain, type AuditActor } from './auditService.ts';
import { requireCapability } from './capabilityService.ts';
import { currentRevision, setDraftState } from './draftService.ts';

export type PublicationOutcome =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'reconciled_success'
  | 'reconciled_failed';

export interface Publication {
  id: string;
  draft_id: string;
  revision_hash: string;
  approval_id: string;
  idempotency_key: string;
  adapter: string;
  linkedin_post_urn: string | null;
  outcome: PublicationOutcome;
  attempted_at: string;
  resolved_at: string | null;
}

function rowToPublication(row: Record<string, unknown>): Publication {
  return {
    id: String(row['id']),
    draft_id: String(row['draft_id']),
    revision_hash: String(row['revision_hash']),
    approval_id: String(row['approval_id']),
    idempotency_key: String(row['idempotency_key']),
    adapter: String(row['adapter']),
    linkedin_post_urn: (row['linkedin_post_urn'] as string | null) ?? null,
    outcome: String(row['outcome']) as PublicationOutcome,
    attempted_at: String(row['attempted_at']),
    resolved_at: (row['resolved_at'] as string | null) ?? null,
  };
}

// The single external-write path. Order matters and is not negotiable:
//   1. verify the audit chain and (for real adapters) the capability gate
//   2. consume the approval with a conditional UPDATE inside one transaction,
//      together with the publish-intent audit event
//   3. only then call the adapter, exactly once, with no automatic retry
// Consuming before sending means a crash mid-flight can never leave a reusable
// approval behind, and a lost response becomes 'ambiguous' rather than a
// silent second post.
export async function executePublication(
  db: SqliteDriver,
  publisher: Publisher,
  input: { approval_id: string; account_id?: string; actor?: AuditActor },
): Promise<Publication> {
  requireIntactChain(db);
  const approval = getApproval(db, input.approval_id);

  if (publisher.name !== 'dry_run') {
    requireCapability(db, 'linkedin.publish_post');
  }
  if (input.account_id && input.account_id !== approval.account_id) {
    throw new DomainError(
      'ACCOUNT_MISMATCH',
      `approval ${approval.id} is bound to account ${approval.account_id}, not ${input.account_id}`,
      { blockers: ['account_mismatch'] },
    );
  }

  const revision = currentRevision(db, approval.draft_id);
  const idempotencyKey = idempotencyKeyFor(approval);

  // A replay of an already-attempted approval never re-sends.
  const existing = db.get('SELECT * FROM publications WHERE idempotency_key = ?', idempotencyKey);
  if (existing) return rowToPublication(existing);

  const publicationId = withWriteTx(db, () => {
    assertApprovalUsable(db, approval, revision.revision_hash);
    const consumed = db.run(
      `UPDATE approvals SET state = 'consumed', consumed_at = ?
       WHERE id = ? AND state = 'granted' AND consumed_at IS NULL AND content_hash = ?`,
      new Date().toISOString(),
      approval.id,
      revision.revision_hash,
    );
    if (Number(consumed.changes) !== 1) {
      throw new DomainError(
        'APPROVAL_INVALIDATED',
        `approval ${approval.id} was consumed or invalidated concurrently; request a fresh approval`,
        { blockers: ['approval_not_consumable'] },
      );
    }
    const id = newId('pub');
    db.run(
      `INSERT INTO publications (id, draft_id, revision_hash, approval_id, idempotency_key, request_hash, adapter, outcome, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      approval.draft_id,
      revision.revision_hash,
      approval.id,
      idempotencyKey,
      createHash('sha256').update(revision.body_text, 'utf8').digest('hex'),
      publisher.name,
      new Date().toISOString(),
    );
    appendAuditEvent(db, {
      event_type: 'publication.in_flight',
      actor: input.actor ?? 'mcp_host',
      subject_type: 'publication',
      subject_id: id,
      payload: {
        approval_id: approval.id,
        draft_id: approval.draft_id,
        revision_hash: revision.revision_hash,
        adapter: publisher.name,
        idempotency_key: idempotencyKey,
      },
    });
    return id;
  });

  let outcome: Awaited<ReturnType<Publisher['publish']>>;
  try {
    outcome = await publisher.publish({
      idempotency_key: idempotencyKey,
      body_text: revision.body_text,
      visibility: approval.visibility,
      media: revision.media,
      account_id: approval.account_id,
    });
  } catch (err) {
    // The request may or may not have reached LinkedIn: record ambiguity
    // rather than guessing, and never retry automatically.
    outcome = { status: 'ambiguous', reason: err instanceof Error ? err.message : String(err) };
  }

  return withWriteTx(db, () => {
    const now = new Date().toISOString();
    if (outcome.status === 'succeeded') {
      db.run(
        "UPDATE publications SET outcome = 'succeeded', linkedin_post_urn = ?, resolved_at = ?, response_meta_json = ? WHERE id = ?",
        outcome.post_urn,
        now,
        JSON.stringify(outcome.meta ?? {}),
        publicationId,
      );
      setDraftState(db, approval.draft_id, 'published');
    } else if (outcome.status === 'failed') {
      db.run(
        "UPDATE publications SET outcome = 'failed', resolved_at = ?, response_meta_json = ? WHERE id = ?",
        now,
        JSON.stringify({ error: outcome.error }),
        publicationId,
      );
    } else {
      db.run(
        "UPDATE publications SET outcome = 'ambiguous', response_meta_json = ? WHERE id = ?",
        JSON.stringify({ reason: outcome.reason }),
        publicationId,
      );
    }
    appendAuditEvent(db, {
      event_type: `publication.${outcome.status}`,
      actor: input.actor ?? 'mcp_host',
      subject_type: 'publication',
      subject_id: publicationId,
      payload: { adapter: publisher.name, draft_id: approval.draft_id },
    });
    return rowToPublication(db.get('SELECT * FROM publications WHERE id = ?', publicationId)!);
  });
}

function assertApprovalUsable(db: SqliteDriver, approval: Approval, currentHash: string): void {
  const fresh = getApproval(db, approval.id);
  if (fresh.state !== 'granted') {
    throw new DomainError(
      'APPROVAL_INVALIDATED',
      `approval ${approval.id} is ${fresh.state}; only a granted approval can be executed`,
      { blockers: [`approval_${fresh.state}`] },
    );
  }
  if (new Date(fresh.expires_at).getTime() < Date.now()) {
    // No write here. This runs inside the caller's withWriteTx, so the throw on
    // the next line rolls the UPDATE straight back — the approval stayed
    // 'granted' in every read path while permanently occupying its draft's one
    // live-approval slot, and the draft could never be approved again. The
    // transition belongs to the boot retention sweep, which is not inside a
    // failing transaction.
    throw new DomainError(
      'APPROVAL_INVALIDATED',
      `approval ${approval.id} expired at ${fresh.expires_at}`,
      {
        blockers: ['approval_expired'],
      },
    );
  }
  if (fresh.content_hash !== currentHash) {
    throw new DomainError(
      'APPROVAL_INVALIDATED',
      'the draft changed after approval; request a fresh approval for the current revision',
      { blockers: ['revision_drift'] },
    );
  }
}

// Ambiguous outcomes are resolved by a human attestation (v1) or, once the DMA
// lane exists, by matching the member's own changelog (P14).
export function reconcilePublication(
  db: SqliteDriver,
  input: {
    publication_id: string;
    method: 'manual_attestation';
    found: boolean;
    confirm: boolean;
    actor: 'mcp_host' | 'dashboard';
    post_url?: string;
  },
): Publication {
  if (!input.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'publication reconciliation is a human attestation: pass confirm: true after checking LinkedIn activity',
    );
  }
  return withWriteTx(db, () => {
    const row = db.get('SELECT * FROM publications WHERE id = ?', input.publication_id);
    if (!row) throw new DomainError('NOT_FOUND', `publication ${input.publication_id} not found`);
    const publication = rowToPublication(row);
    // 'pending' is reconcilable too. A row is inserted as 'pending' before the
    // network call and only moves afterwards, so a crash — or any failure in
    // the bookkeeping that follows the POST — strands it there forever: the
    // approval is already consumed, the idempotency key blocks a retry, and
    // refusing to reconcile left no way out at all. Its situation is exactly
    // the ambiguous one: nobody knows whether the post went out.
    if (publication.outcome !== 'ambiguous' && publication.outcome !== 'pending') {
      throw new DomainError(
        'INVALID_INPUT',
        `publication ${publication.id} is ${publication.outcome}; only ambiguous or pending outcomes need reconciliation`,
      );
    }
    if (input.post_url && !/^https:\/\/(www\.)?linkedin\.com\//i.test(input.post_url)) {
      throw new DomainError('INVALID_INPUT', 'post_url must be a https://www.linkedin.com/ URL');
    }
    const now = new Date().toISOString();
    if (input.found) {
      db.run(
        "UPDATE publications SET outcome = 'reconciled_success', linkedin_post_urn = ?, resolved_at = ? WHERE id = ?",
        input.post_url ?? null,
        now,
        publication.id,
      );
      setDraftState(db, publication.draft_id, 'published');
    } else {
      db.run(
        "UPDATE publications SET outcome = 'reconciled_failed', resolved_at = ? WHERE id = ?",
        now,
        publication.id,
      );
    }
    appendAuditEvent(db, {
      event_type: input.found ? 'publication.reconciled_success' : 'publication.reconciled_failed',
      actor: input.actor,
      subject_type: 'publication',
      subject_id: publication.id,
      payload: { method: input.method, post_url: input.post_url ?? null },
    });
    return rowToPublication(db.get('SELECT * FROM publications WHERE id = ?', publication.id)!);
  });
}

export function listPublications(db: SqliteDriver, outcome?: PublicationOutcome): Publication[] {
  const rows = outcome
    ? db.all('SELECT * FROM publications WHERE outcome = ? ORDER BY attempted_at DESC', outcome)
    : db.all('SELECT * FROM publications ORDER BY attempted_at DESC');
  return rows.map(rowToPublication);
}
