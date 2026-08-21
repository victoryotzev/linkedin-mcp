import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';

// Analytics for a single account are a weak instrument, and the honest thing
// is to say so in the output rather than dress up noise as insight. Every
// comparison carries its sample size, its confounders and a confidence label
// that is capped well below "proof".

export type ObservationSource = 'manual_import' | 'dma' | 'api';

export interface Observation {
  id: string;
  subject_type: 'post' | 'profile' | 'follower';
  subject_ref: string;
  metric: string;
  value: number;
  observed_at: string;
  window_start: string | null;
  window_end: string | null;
  source: ObservationSource;
  retention_class: string;
  note: string | null;
}

export interface ImportRow {
  subject_type?: 'post' | 'profile' | 'follower';
  subject_ref: string;
  metric: string;
  value: number;
  observed_at: string;
  window_start?: string;
  window_end?: string;
  note?: string;
}

// Marketing/CM-sourced social activity carries a 48-hour storage cap; own-data
// sources do not. The class travels with the row so the retention sweep can
// enforce the right rule per record.
function retentionClassFor(source: ObservationSource): string {
  return source === 'api' ? 'marketing_48h' : 'durable_user';
}

export function importObservations(
  db: SqliteDriver,
  rows: ImportRow[],
  opts: { source?: ObservationSource; provenance_artifact_id?: string } = {},
): { imported: number; duplicates: number; rejected: Array<{ row: number; reason: string }> } {
  const source = opts.source ?? 'manual_import';

  // Counters live INSIDE the transaction body and are returned from it.
  // withWriteTx re-runs its body on SQLITE_BUSY; accumulators declared outside
  // survive that rollback and are then counted a second time, so the function
  // reports imports that are not in the database.
  return withWriteTx(db, () => {
    const rejected: Array<{ row: number; reason: string }> = [];
    let imported = 0;
    let duplicates = 0;
    rows.forEach((row, index) => {
      if (!row.subject_ref || !row.metric || !row.observed_at) {
        rejected.push({ row: index, reason: 'subject_ref, metric and observed_at are required' });
        return;
      }
      if (!Number.isFinite(row.value)) {
        rejected.push({ row: index, reason: `value is not a finite number: ${String(row.value)}` });
        return;
      }
      const existing = db.get(
        'SELECT 1 AS x FROM analytics_observations WHERE subject_ref = ? AND metric = ? AND observed_at = ?',
        row.subject_ref,
        row.metric,
        row.observed_at,
      );
      if (existing) {
        duplicates += 1;
        return;
      }
      db.run(
        `INSERT INTO analytics_observations (id, subject_type, subject_ref, metric, value, observed_at, window_start, window_end, source, provenance_artifact_id, retention_class, note, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('obs'),
        row.subject_type ?? 'post',
        row.subject_ref,
        row.metric,
        row.value,
        row.observed_at,
        row.window_start ?? null,
        row.window_end ?? null,
        source,
        opts.provenance_artifact_id ?? null,
        retentionClassFor(source),
        row.note ?? null,
        new Date().toISOString(),
      );
      imported += 1;
    });
    return { imported, duplicates, rejected };
  });
}

export function listObservations(
  db: SqliteDriver,
  filters: { subject_ref?: string; metric?: string; limit?: number; offset?: number } = {},
): Observation[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.subject_ref) {
    clauses.push('subject_ref = ?');
    params.push(filters.subject_ref);
  }
  if (filters.metric) {
    clauses.push('metric = ?');
    params.push(filters.metric);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // OFFSET belongs in SQL. The MCP tool used to fetch this default 200 and then
  // paginate the array, so has_more was computed against the truncated window
  // and every observation past the 200th was unreachable through any page.
  params.push(filters.limit ?? 200, filters.offset ?? 0);
  return db
    .all(
      `SELECT * FROM analytics_observations ${where} ORDER BY observed_at DESC LIMIT ? OFFSET ?`,
      ...params,
    )
    .map((row) => ({
      id: String(row['id']),
      subject_type: String(row['subject_type']) as Observation['subject_type'],
      subject_ref: String(row['subject_ref']),
      metric: String(row['metric']),
      value: Number(row['value']),
      observed_at: String(row['observed_at']),
      window_start: (row['window_start'] as string | null) ?? null,
      window_end: (row['window_end'] as string | null) ?? null,
      source: String(row['source']) as ObservationSource,
      retention_class: String(row['retention_class']),
      note: (row['note'] as string | null) ?? null,
    }));
}

export type ConfidenceLabel = 'anecdote' | 'weak' | 'moderate';

export interface CohortComparison {
  metric: string;
  cohort_a: { refs: string[]; n: number; mean: number | null; latest_values: number[] };
  cohort_b: { refs: string[]; n: number; mean: number | null; latest_values: number[] };
  difference: number | null;
  confidence: ConfidenceLabel;
  caveats: string[];
}

const MIN_MODERATE_N = 12;
const MIN_WEAK_N = 5;

export function compareCohorts(
  db: SqliteDriver,
  input: { metric: string; cohort_a: string[]; cohort_b: string[] },
): CohortComparison {
  if (input.cohort_a.length === 0 || input.cohort_b.length === 0) {
    throw new DomainError('INVALID_INPUT', 'both cohorts need at least one subject_ref');
  }
  // Duplicates used to count. Repeating one post id twelve times produced n=12
  // and promoted the honesty label from 'anecdote' to 'moderate' — the label
  // exists precisely to stop that kind of self-deception.
  const overlap = input.cohort_a.filter((ref) => input.cohort_b.includes(ref));
  if (overlap.length > 0) {
    throw new DomainError(
      'INVALID_INPUT',
      `cohorts must be disjoint; ${overlap.join(', ')} appear(s) in both`,
    );
  }

  const side = (rawRefs: string[]) => {
    const refs = [...new Set(rawRefs)];
    const values = refs
      .map((ref) => {
        const row = db.get(
          'SELECT value FROM analytics_observations WHERE subject_ref = ? AND metric = ? ORDER BY observed_at DESC',
          ref,
          input.metric,
        );
        return row ? Number(row['value']) : null;
      })
      .filter((v): v is number => v !== null);
    return {
      refs,
      n: values.length,
      mean:
        values.length === 0
          ? null
          : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
      latest_values: values,
    };
  };

  const a = side(input.cohort_a);
  const b = side(input.cohort_b);
  const smallest = Math.min(a.n, b.n);

  // The ceiling is 'moderate' by construction: one account's posting history
  // cannot support a causal claim, and pretending otherwise is how people talk
  // themselves into engagement folklore.
  const confidence: ConfidenceLabel =
    smallest >= MIN_MODERATE_N ? 'moderate' : smallest >= MIN_WEAK_N ? 'weak' : 'anecdote';

  const caveats = [
    `smallest cohort has n=${smallest}; this is descriptive, not causal`,
    'posts differ in topic, timing, length and audience — none of these are controlled',
    'LinkedIn reach varies with factors outside this dataset (feed ranking, follower growth, time of day)',
  ];
  if (confidence === 'anecdote') {
    caveats.unshift(
      'sample far too small to distinguish signal from noise: treat as anecdote only',
    );
  }

  return {
    metric: input.metric,
    cohort_a: a,
    cohort_b: b,
    difference: a.mean !== null && b.mean !== null ? Number((a.mean - b.mean).toFixed(2)) : null,
    confidence,
    caveats,
  };
}

export function metricsSummary(
  db: SqliteDriver,
): Array<{ metric: string; observations: number; subjects: number }> {
  return db
    .all(
      `SELECT metric, COUNT(*) AS observations, COUNT(DISTINCT subject_ref) AS subjects
       FROM analytics_observations GROUP BY metric ORDER BY metric`,
    )
    .map((row) => ({
      metric: String(row['metric']),
      observations: Number(row['observations']),
      subjects: Number(row['subjects']),
    }));
}
