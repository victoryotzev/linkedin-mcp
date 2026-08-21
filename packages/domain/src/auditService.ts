import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { canonicalJson, DomainError, type Jsonish } from '@linkedin-mcp/shared';

// Hash-chained append-only audit log (semantics ported from the Seller
// project's events.py): each entry hashes its canonical body together with its
// predecessor's hash, so removing or editing any entry breaks every hash after
// it. Approval and publish paths verify the chain first and refuse to run when
// it does not hold — a tampered history must never authorise an external act.

export const GENESIS_HASH = '0'.repeat(64);
export type AuditActor = 'mcp_host' | 'dashboard' | 'human_cli' | 'system';
export type HumanActor = 'dashboard' | 'human_cli';

// Linking rows to each other proves nothing about the ENDS of the chain. Both
// ends are anchored here instead: the highest seq ever written and the hash at
// that seq, updated in the same transaction as every append. Without it,
// deleting the newest events — or the entire table, after which fresh events
// re-chain cleanly from genesis — verified as intact.
const AUDIT_HEAD_KEY = 'audit.head';

interface AuditAnchor {
  seq: number;
  hash: string;
}

function readAnchor(db: SqliteDriver): AuditAnchor | null {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', AUDIT_HEAD_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row['value_json'])) as Partial<AuditAnchor>;
    if (typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string') return null;
    return { seq: parsed.seq, hash: parsed.hash };
  } catch {
    return null;
  }
}

export interface AuditEvent {
  seq: number;
  event_type: string;
  actor: AuditActor;
  subject_type: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  content_hash: string;
  created_at: string;
}

function computeHash(input: {
  prev_hash: string;
  event_type: string;
  actor: string;
  subject_type: string;
  subject_id: string | null;
  payload: Jsonish;
  created_at: string;
}): string {
  return createHash('sha256')
    .update(
      `${input.prev_hash}|${canonicalJson({
        event_type: input.event_type,
        actor: input.actor,
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        payload: input.payload,
        created_at: input.created_at,
      })}`,
      'utf8',
    )
    .digest('hex');
}

export function appendAuditEvent(
  db: SqliteDriver,
  input: {
    event_type: string;
    actor: AuditActor;
    subject_type: string;
    subject_id?: string;
    payload?: Record<string, Jsonish>;
  },
): AuditEvent {
  return withWriteTx(db, () => {
    const head = db.get('SELECT content_hash FROM audit_events ORDER BY seq DESC');
    const prevHash = head ? String(head['content_hash']) : GENESIS_HASH;
    const createdAt = new Date().toISOString();
    const payload = (input.payload ?? {}) as Jsonish;
    const contentHash = computeHash({
      prev_hash: prevHash,
      event_type: input.event_type,
      actor: input.actor,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      payload,
      created_at: createdAt,
    });
    const result = db.run(
      `INSERT INTO audit_events (event_type, actor, subject_type, subject_id, payload_json, prev_hash, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.event_type,
      input.actor,
      input.subject_type,
      input.subject_id ?? null,
      canonicalJson(payload),
      prevHash,
      contentHash,
      createdAt,
    );
    // Same transaction as the INSERT, deliberately: an anchor that could lag
    // behind the log by even one event would make honest appends look like
    // tampering, and a crash between the two writes would do exactly that.
    const seq = Number(result.lastInsertRowid);
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      AUDIT_HEAD_KEY,
      JSON.stringify({ seq, hash: contentHash } satisfies AuditAnchor),
      createdAt,
    );

    return {
      seq,
      event_type: input.event_type,
      actor: input.actor,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      prev_hash: prevHash,
      content_hash: contentHash,
      created_at: createdAt,
    };
  });
}

export interface ChainStatus {
  valid: boolean;
  length: number;
  head_hash: string;
  broken_at_seq: number | null;
  reason: string | null;
  /** False only on a database whose anchor row was removed after migration 013. */
  head_anchored: boolean;
}

export function verifyAuditChain(db: SqliteDriver): ChainStatus {
  const rows = db.all('SELECT * FROM audit_events ORDER BY seq');
  const anchor = readAnchor(db);
  const anchored = anchor !== null;
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const seq = Number(row['seq']);
    if (String(row['prev_hash']) !== prev) {
      return {
        valid: false,
        length: rows.length,
        head_hash: prev,
        broken_at_seq: seq,
        reason:
          'prev_hash does not match the previous entry (an entry was removed, reordered or inserted)',
        head_anchored: anchored,
      };
    }
    const recomputed = computeHash({
      prev_hash: prev,
      event_type: String(row['event_type']),
      actor: String(row['actor']),
      subject_type: String(row['subject_type']),
      subject_id: (row['subject_id'] as string | null) ?? null,
      payload: JSON.parse(String(row['payload_json'])) as Jsonish,
      created_at: String(row['created_at']),
    });
    if (recomputed !== String(row['content_hash'])) {
      return {
        valid: false,
        length: rows.length,
        head_hash: prev,
        broken_at_seq: seq,
        reason:
          'content_hash does not match the entry body (the entry was edited after it was written)',
        head_anchored: anchored,
      };
    }
    prev = recomputed;
  }

  // The walk above cannot see what is no longer there. Only the anchor can.
  const maxSeq = rows.length === 0 ? 0 : Number(rows[rows.length - 1]!['seq']);
  if (anchor === null) {
    return {
      valid: false,
      length: rows.length,
      head_hash: prev,
      broken_at_seq: null,
      reason:
        'the audit head anchor is missing from settings; every migrated database has one, so its absence means the anchor was deleted',
      head_anchored: false,
    };
  }
  if (anchor.seq > maxSeq) {
    return {
      valid: false,
      length: rows.length,
      head_hash: prev,
      broken_at_seq: maxSeq,
      reason: `the log ends at seq ${maxSeq} but ${anchor.seq} events were written; the newest ${anchor.seq - maxSeq} entr(ies) were deleted`,
      head_anchored: true,
    };
  }
  if (anchor.seq < maxSeq) {
    // Nothing in the codebase writes audit_events outside appendAuditEvent, and
    // that updates the anchor in the same transaction. Rows beyond the recorded
    // head therefore arrived by direct SQL.
    return {
      valid: false,
      length: rows.length,
      head_hash: prev,
      broken_at_seq: anchor.seq + 1,
      reason: `the log contains entries past the recorded head (seq ${anchor.seq}); ${maxSeq - anchor.seq} entr(ies) were inserted outside the append path`,
      head_anchored: true,
    };
  }
  if (anchor.hash !== prev) {
    return {
      valid: false,
      length: rows.length,
      head_hash: prev,
      broken_at_seq: maxSeq,
      reason: 'the newest entry does not match the recorded head hash (the tail was rewritten)',
      head_anchored: true,
    };
  }

  return {
    valid: true,
    length: rows.length,
    head_hash: prev,
    broken_at_seq: null,
    reason: null,
    head_anchored: true,
  };
}

// Every path with an external effect calls this before acting.
export function requireIntactChain(db: SqliteDriver): void {
  const status = verifyAuditChain(db);
  if (!status.valid) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `audit chain is broken at seq ${status.broken_at_seq}: ${status.reason}. External actions are refused until the database is restored from a verified backup.`,
      { blockers: ['audit_chain_broken'] },
    );
  }
}

export function queryAuditEvents(
  db: SqliteDriver,
  filters: {
    event_type?: string;
    subject_id?: string;
    since?: string;
    max_seq?: number;
    limit?: number;
    offset?: number;
  } = {},
): AuditEvent[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.event_type) {
    clauses.push('event_type = ?');
    params.push(filters.event_type);
  }
  if (filters.subject_id) {
    clauses.push('subject_id = ?');
    params.push(filters.subject_id);
  }
  if (filters.since) {
    clauses.push('created_at >= ?');
    params.push(filters.since);
  }
  if (filters.max_seq !== undefined) {
    clauses.push('seq <= ?');
    params.push(filters.max_seq);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit ?? 100);
  params.push(filters.offset ?? 0);
  return db
    .all(`SELECT * FROM audit_events ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`, ...params)
    .map((row) => ({
      seq: Number(row['seq']),
      event_type: String(row['event_type']),
      actor: String(row['actor']) as AuditEvent['actor'],
      subject_type: String(row['subject_type']),
      subject_id: (row['subject_id'] as string | null) ?? null,
      payload: JSON.parse(String(row['payload_json'])) as Record<string, unknown>,
      prev_hash: String(row['prev_hash']),
      content_hash: String(row['content_hash']),
      created_at: String(row['created_at']),
    }));
}
