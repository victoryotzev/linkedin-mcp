import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  compareCohorts,
  importObservations,
  listObservations,
  runRetentionSweep,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-ana-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const row = (ref: string, value: number, at: string) => ({
  subject_ref: ref,
  metric: 'impressions',
  value,
  observed_at: at,
});

describe('analytics import', () => {
  it('imports, dedups and reports malformed rows without aborting the batch', () => {
    const result = importObservations(db, [
      row('urn:li:share:1', 120, '2026-08-01'),
      row('urn:li:share:1', 120, '2026-08-01'),
      { subject_ref: '', metric: 'impressions', value: 5, observed_at: '2026-08-01' },
      {
        subject_ref: 'urn:li:share:2',
        metric: 'impressions',
        value: Number.NaN,
        observed_at: '2026-08-01',
      },
      row('urn:li:share:2', 340, '2026-08-03'),
    ]);
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.rejected).toHaveLength(2);
    expect(listObservations(db)).toHaveLength(2);
  });

  it('tags manual imports as durable and API-sourced rows as 48-hour', () => {
    importObservations(db, [row('urn:li:share:1', 1, '2026-08-01')]);
    importObservations(db, [row('urn:li:share:9', 2, '2026-08-01')], { source: 'api' });
    const classes = listObservations(db)
      .map((o) => o.retention_class)
      .sort();
    expect(classes).toEqual(['durable_user', 'marketing_48h']);
  });

  it('sweeps expired Marketing-sourced rows and keeps own-data rows', () => {
    importObservations(db, [row('urn:li:share:1', 1, '2026-08-01')]);
    importObservations(db, [row('urn:li:share:9', 2, '2026-08-01')], { source: 'api' });
    db.run(
      "UPDATE analytics_observations SET imported_at = '2026-08-01T00:00:00Z' WHERE retention_class = 'marketing_48h'",
    );
    const report = runRetentionSweep(db, new Date('2026-08-09T00:00:00Z'));
    expect(report.observations_expired).toBe(1);
    expect(listObservations(db).map((o) => o.retention_class)).toEqual(['durable_user']);
  });
});

describe('cohort comparison honesty', () => {
  it('labels tiny samples as anecdote and leads with the warning', () => {
    importObservations(db, [row('a1', 100, '2026-08-01'), row('b1', 200, '2026-08-01')]);
    const comparison = compareCohorts(db, {
      metric: 'impressions',
      cohort_a: ['a1'],
      cohort_b: ['b1'],
    });
    expect(comparison.confidence).toBe('anecdote');
    expect(comparison.difference).toBe(-100);
    expect(comparison.caveats[0]).toContain('too small');
  });

  it('never exceeds moderate confidence, however large the sample', () => {
    const rows = [];
    for (let i = 0; i < 40; i++) {
      rows.push(row(`a${i}`, 100 + i, '2026-08-01'), row(`b${i}`, 200 + i, '2026-08-01'));
    }
    importObservations(db, rows);
    const comparison = compareCohorts(db, {
      metric: 'impressions',
      cohort_a: Array.from({ length: 40 }, (_, i) => `a${i}`),
      cohort_b: Array.from({ length: 40 }, (_, i) => `b${i}`),
    });
    expect(comparison.confidence).toBe('moderate');
    expect(comparison.caveats.join(' ')).toContain('not causal');
  });

  it('refuses an empty cohort', () => {
    expect(() =>
      compareCohorts(db, { metric: 'impressions', cohort_a: [], cohort_b: ['b1'] }),
    ).toThrowError(DomainError);
  });
});
