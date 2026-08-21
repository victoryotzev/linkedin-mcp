import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { significantTokens } from './coverageService.ts';

// Post ideas are derived from verified claims that have NOT already been
// covered by an earlier post or draft — the ledger decides what there is to
// say, and the published history decides what is already said.

export interface Opportunity {
  claim_id: string;
  statement: string;
  limitations: string | null;
  novelty: number;
  pillar_id: string | null;
  closest_prior: string | null;
}

export function contentOpportunities(
  db: SqliteDriver,
  opts: { pillar_id?: string; limit?: number; offset?: number } = {},
): Opportunity[] {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  const claims = db.all(
    "SELECT id, statement, limitations FROM claims WHERE state = 'verified' ORDER BY created_at DESC",
  );

  const priors: Array<{ label: string; tokens: Set<string> }> = [
    ...db.all('SELECT posted_at, commentary FROM published_posts').map((r) => ({
      label: `published ${String(r['posted_at'])}`,
      tokens: significantTokens(String(r['commentary'])),
    })),
    ...db
      .all(
        'SELECT dr.draft_id, dr.body_text FROM draft_revisions dr JOIN post_drafts d ON d.id = dr.draft_id AND d.current_revision = dr.revision',
      )
      .map((r) => ({
        label: `draft ${String(r['draft_id'])}`,
        tokens: significantTokens(String(r['body_text'])),
      })),
  ];

  const scored = claims.map((claim) => {
    const tokens = significantTokens(String(claim['statement']));
    let best = 0;
    let closest: string | null = null;
    for (const prior of priors) {
      const overlap = coverageRatio(tokens, prior.tokens);
      if (overlap > best) {
        best = overlap;
        closest = prior.label;
      }
    }
    return {
      claim_id: String(claim['id']),
      statement: String(claim['statement']),
      limitations: (claim['limitations'] as string | null) ?? null,
      novelty: Number((1 - best).toFixed(2)),
      pillar_id: opts.pillar_id ?? null,
      closest_prior: closest,
    };
  });

  return scored.sort((a, b) => b.novelty - a.novelty).slice(offset, offset + limit);
}

function coverageRatio(claim: Set<string>, prior: Set<string>): number {
  if (claim.size === 0) return 0;
  let shared = 0;
  for (const token of claim) if (prior.has(token)) shared += 1;
  return shared / claim.size;
}

// ---- pillars & calendar (planning metadata only; nothing ever fires) ----

export interface Pillar {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  status: string;
}

export function upsertPillar(
  db: SqliteDriver,
  input: { id?: string; name: string; description?: string; audience?: string },
): Pillar {
  return withWriteTx(db, () => {
    if (input.id) {
      db.run(
        'UPDATE content_pillars SET name = ?, description = ?, audience = ? WHERE id = ?',
        input.name,
        input.description ?? null,
        input.audience ?? null,
        input.id,
      );
      return getPillar(db, input.id);
    }
    const id = newId('cal');
    db.run(
      `INSERT INTO content_pillars (id, name, description, audience, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      id,
      input.name,
      input.description ?? null,
      input.audience ?? null,
      new Date().toISOString(),
    );
    return getPillar(db, id);
  });
}

export function getPillar(db: SqliteDriver, id: string): Pillar {
  const row = db.get('SELECT * FROM content_pillars WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `pillar ${id} not found`);
  return {
    id: String(row['id']),
    name: String(row['name']),
    description: (row['description'] as string | null) ?? null,
    audience: (row['audience'] as string | null) ?? null,
    status: String(row['status']),
  };
}

export function listPillars(db: SqliteDriver): Pillar[] {
  return db.all('SELECT * FROM content_pillars ORDER BY name').map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    description: (row['description'] as string | null) ?? null,
    audience: (row['audience'] as string | null) ?? null,
    status: String(row['status']),
  }));
}

export interface CalendarEntry {
  id: string;
  draft_id: string | null;
  pillar_id: string | null;
  intended_date: string;
  status: CalendarStatus;
  note: string | null;
}

export type CalendarStatus = 'planned' | 'drafted' | 'approved' | 'published' | 'skipped';

const CALENDAR_STATUSES = new Set<CalendarStatus>([
  'planned',
  'drafted',
  'approved',
  'published',
  'skipped',
]);

export function upsertCalendarEntry(
  db: SqliteDriver,
  input: {
    id?: string;
    draft_id?: string | null;
    pillar_id?: string | null;
    intended_date?: string;
    status?: CalendarEntry['status'];
    note?: string | null;
  },
): CalendarEntry {
  return withWriteTx(db, () => {
    const id = input.id ?? newId('cal');
    if (input.status !== undefined && !CALENDAR_STATUSES.has(input.status)) {
      throw new DomainError(
        'INVALID_INPUT',
        `unsupported calendar status: ${String(input.status)}`,
      );
    }
    assertCalendarReference(db, 'post_drafts', 'draft', input.draft_id);
    assertCalendarReference(db, 'content_pillars', 'pillar', input.pillar_id);
    if (input.id) {
      const existing = db.get('SELECT * FROM calendar_entries WHERE id = ?', id);
      if (!existing) throw new DomainError('NOT_FOUND', `calendar entry ${id} not found`);
      const intendedDate = input.intended_date ?? String(existing['intended_date']);
      assertCalendarDate(intendedDate);
      db.run(
        'UPDATE calendar_entries SET draft_id = ?, pillar_id = ?, intended_date = ?, status = ?, note = ? WHERE id = ?',
        input.draft_id === undefined ? (existing['draft_id'] as string | null) : input.draft_id,
        input.pillar_id === undefined ? (existing['pillar_id'] as string | null) : input.pillar_id,
        intendedDate,
        input.status ?? String(existing['status']),
        input.note === undefined ? (existing['note'] as string | null) : input.note,
        id,
      );
    } else {
      if (input.intended_date === undefined) {
        throw new DomainError('INVALID_INPUT', 'a new calendar entry requires intended_date');
      }
      assertCalendarDate(input.intended_date);
      db.run(
        `INSERT INTO calendar_entries (id, draft_id, pillar_id, intended_date, status, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        input.draft_id ?? null,
        input.pillar_id ?? null,
        input.intended_date,
        input.status ?? 'planned',
        input.note ?? null,
      );
    }
    const row = db.get('SELECT * FROM calendar_entries WHERE id = ?', id)!;
    return {
      id: String(row['id']),
      draft_id: (row['draft_id'] as string | null) ?? null,
      pillar_id: (row['pillar_id'] as string | null) ?? null,
      intended_date: String(row['intended_date']),
      status: String(row['status']) as CalendarStatus,
      note: (row['note'] as string | null) ?? null,
    };
  });
}

function assertCalendarDate(value: string): void {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!date || (value.length > 10 && !timestamp.test(value)) || Number.isNaN(Date.parse(value))) {
    throw new DomainError('INVALID_INPUT', 'intended_date must be an ISO-8601 date or timestamp');
  }
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    throw new DomainError('INVALID_INPUT', 'intended_date is not a real calendar date');
  }
}

function assertCalendarReference(
  db: SqliteDriver,
  table: 'post_drafts' | 'content_pillars',
  label: 'draft' | 'pillar',
  id: string | null | undefined,
): void {
  if (id === undefined || id === null) return;
  if (!db.get(`SELECT id FROM ${table} WHERE id = ?`, id)) {
    throw new DomainError('NOT_FOUND', `${label} ${id} not found`);
  }
}

export function listCalendar(db: SqliteDriver): CalendarEntry[] {
  return db.all('SELECT * FROM calendar_entries ORDER BY intended_date').map((row) => ({
    id: String(row['id']),
    draft_id: (row['draft_id'] as string | null) ?? null,
    pillar_id: (row['pillar_id'] as string | null) ?? null,
    intended_date: String(row['intended_date']),
    status: String(row['status']) as CalendarStatus,
    note: (row['note'] as string | null) ?? null,
  }));
}
