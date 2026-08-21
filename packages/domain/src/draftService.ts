import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { canonicalJson, DomainError, newId } from '@linkedin-mcp/shared';
import { invalidateApprovalsForDraft } from './approvalService.ts';

export type DraftState = 'draft' | 'validated' | 'approved' | 'published' | 'abandoned';

export interface DraftRevision {
  draft_id: string;
  revision: number;
  body_text: string;
  media: Array<{ artifact_id: string; alt: string }>;
  visibility: 'PUBLIC' | 'CONNECTIONS';
  revision_hash: string;
  created_at: string;
}

export interface Draft {
  id: string;
  slug: string;
  pillar_id: string | null;
  state: DraftState;
  current_revision: number;
  current_revision_hash: string | null;
  created_at: string;
  updated_at: string;
}

export function revisionHash(
  body: string,
  media: Array<{ artifact_id: string; alt: string }>,
  visibility: string,
): string {
  return createHash('sha256')
    .update(canonicalJson({ body, media: media.map((m) => ({ ...m })), visibility }), 'utf8')
    .digest('hex');
}

function rowToDraft(row: Record<string, unknown>): Draft {
  return {
    id: String(row['id']),
    slug: String(row['slug']),
    pillar_id: (row['pillar_id'] as string | null) ?? null,
    state: String(row['state']) as DraftState,
    current_revision: Number(row['current_revision']),
    current_revision_hash: (row['current_revision_hash'] as string | null) ?? null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

export function getDraft(db: SqliteDriver, id: string): Draft {
  const row = db.get('SELECT * FROM post_drafts WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `draft ${id} not found`);
  return rowToDraft(row);
}

// Append-only revisions. A new revision always drops the draft back to
// 'draft': validation and (later) approval are bound to a revision hash, so
// editing the text must invalidate both.
export function writeDraft(
  db: SqliteDriver,
  input: {
    draft_id?: string;
    slug?: string;
    body_text: string;
    media?: Array<{ artifact_id: string; alt: string }>;
    visibility?: 'PUBLIC' | 'CONNECTIONS';
    pillar_id?: string;
  },
): { draft: Draft; revision: DraftRevision } {
  const body = input.body_text.trim();
  if (body.length === 0) throw new DomainError('INVALID_INPUT', 'draft body cannot be empty');
  const media = input.media ?? [];
  const visibility = input.visibility ?? 'PUBLIC';

  return withWriteTx(db, () => {
    for (const item of media) {
      if (!db.get('SELECT 1 AS x FROM artifacts WHERE id = ?', item.artifact_id)) {
        throw new DomainError('NOT_FOUND', `media artifact ${item.artifact_id} not found`);
      }
    }
    const now = new Date().toISOString();
    let draft: Draft;
    if (input.draft_id) {
      draft = getDraft(db, input.draft_id);
      if (draft.state === 'published' || draft.state === 'abandoned') {
        throw new DomainError('TERMINAL_STATE', `draft ${draft.id} is ${draft.state}`);
      }
    } else {
      const id = newId('drf');
      const slug = (input.slug ?? body.slice(0, 40))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      db.run(
        `INSERT INTO post_drafts (id, slug, pillar_id, state, current_revision, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', 0, ?, ?)`,
        id,
        slug || 'draft',
        input.pillar_id ?? null,
        now,
        now,
      );
      draft = getDraft(db, id);
    }

    const revisionNumber = draft.current_revision + 1;
    const hash = revisionHash(body, media, visibility);
    db.run(
      `INSERT INTO draft_revisions (draft_id, revision, body_text, media_json, visibility, revision_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      draft.id,
      revisionNumber,
      body,
      JSON.stringify(media),
      visibility,
      hash,
      now,
    );
    db.run(
      `UPDATE post_drafts SET current_revision = ?, current_revision_hash = ?, state = 'draft',
         pillar_id = COALESCE(?, pillar_id), updated_at = ? WHERE id = ?`,
      revisionNumber,
      hash,
      input.pillar_id ?? null,
      now,
      draft.id,
    );
    // An approval describes one exact text. Editing the draft kills any live
    // approval in the same transaction as the edit itself, so no window exists
    // where an approval outlives the words it approved.
    if (revisionNumber > 1) {
      invalidateApprovalsForDraft(db, draft.id, `draft revised to revision ${revisionNumber}`);
    }

    return {
      draft: getDraft(db, draft.id),
      revision: {
        draft_id: draft.id,
        revision: revisionNumber,
        body_text: body,
        media,
        visibility,
        revision_hash: hash,
        created_at: now,
      },
    };
  });
}

// Loads the exact revision an approval is bound to. Anything showing a human
// what they are approving must use this, never currentRevision: revisions are
// append-only, so the bound one is always still there, and rendering the
// current text under the bound hash means the preview can disagree with what
// would actually be published.
export function revisionByHash(
  db: SqliteDriver,
  draftId: string,
  revisionHash: string,
): DraftRevision | null {
  const row = db.get(
    'SELECT * FROM draft_revisions WHERE draft_id = ? AND revision_hash = ?',
    draftId,
    revisionHash,
  );
  if (!row) return null;
  return {
    draft_id: draftId,
    revision: Number(row['revision']),
    body_text: String(row['body_text']),
    media: JSON.parse(String(row['media_json'])) as Array<{ artifact_id: string; alt: string }>,
    visibility: String(row['visibility']) as 'PUBLIC' | 'CONNECTIONS',
    revision_hash: String(row['revision_hash']),
    created_at: String(row['created_at']),
  };
}

export function currentRevision(db: SqliteDriver, draftId: string): DraftRevision {
  const draft = getDraft(db, draftId);
  const row = db.get(
    'SELECT * FROM draft_revisions WHERE draft_id = ? AND revision = ?',
    draftId,
    draft.current_revision,
  );
  if (!row) throw new DomainError('NOT_FOUND', `draft ${draftId} has no revisions`);
  return {
    draft_id: draftId,
    revision: Number(row['revision']),
    body_text: String(row['body_text']),
    media: JSON.parse(String(row['media_json'])) as Array<{ artifact_id: string; alt: string }>,
    visibility: String(row['visibility']) as 'PUBLIC' | 'CONNECTIONS',
    revision_hash: String(row['revision_hash']),
    created_at: String(row['created_at']),
  };
}

export function listDrafts(
  db: SqliteDriver,
  filters: { state?: DraftState; pillar_id?: string; limit?: number } = {},
): Draft[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.state) {
    clauses.push('state = ?');
    params.push(filters.state);
  }
  if (filters.pillar_id) {
    clauses.push('pillar_id = ?');
    params.push(filters.pillar_id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // Bounded by default. The dashboard runs latestValidation per returned draft,
  // so an unbounded list made one screen cost a query per draft ever written.
  params.push(filters.limit ?? 200);
  return db
    .all(`SELECT * FROM post_drafts ${where} ORDER BY updated_at DESC LIMIT ?`, ...params)
    .map(rowToDraft);
}

export interface DraftRevisionSummary {
  revision: number;
  revision_hash: string;
  visibility: string;
  created_at: string;
  chars: number;
}

// The revision history without the bodies. Approvals bind to a revision hash,
// so being able to see which revisions exist — and which one an approval points
// at — is part of understanding what would actually publish.
export function listDraftRevisions(
  db: SqliteDriver,
  draftId: string,
  opts: { limit?: number } = {},
): DraftRevisionSummary[] {
  return db
    .all(
      `SELECT revision, revision_hash, visibility, created_at, LENGTH(body_text) AS chars
       FROM draft_revisions WHERE draft_id = ? ORDER BY revision DESC LIMIT ?`,
      draftId,
      opts.limit ?? 50,
    )
    .map((row) => ({
      revision: Number(row['revision']),
      revision_hash: String(row['revision_hash']),
      visibility: String(row['visibility']),
      created_at: String(row['created_at']),
      chars: Number(row['chars']),
    }));
}

export function setDraftState(db: SqliteDriver, draftId: string, state: DraftState): Draft {
  return withWriteTx(db, () => {
    db.run(
      'UPDATE post_drafts SET state = ?, updated_at = ? WHERE id = ?',
      state,
      new Date().toISOString(),
      draftId,
    );
    return getDraft(db, draftId);
  });
}
