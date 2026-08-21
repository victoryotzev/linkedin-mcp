import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The three things the analytics tool can be asked for, and the caveats that
// travel with the third.
//
// Comparing two cohorts of posts is the closest this product comes to telling a
// member what works, and it is the easiest place to mislead them: a difference
// between four posts and three is not a finding. The comparison carries its own
// caveats for exactly that reason, and they have to survive the trip out.

let fixture: Fixture;
let call: (name: string, args: unknown) => Promise<unknown>;

beforeEach(() => {
  fixture = createFixture('analytics-views');
  seedHealthy(fixture);
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
  } as never);
  call = async (name, args) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
});

afterEach(() => fixture.close());

async function observe(
  rows: Array<{ subject_ref: string; metric: string; value: number; observed_at: string }>,
): Promise<void> {
  await call('linkedin_analytics_import', { rows, confirm: true });
}

const day = (n: number) => `2026-0${n}-01T00:00:00.000Z`;

describe('the summary view', () => {
  it('answers on an empty corpus rather than failing', async () => {
    const out = (await call('linkedin_analytics_query', { view: 'summary' })) as {
      items: unknown[];
      summary: Record<string, unknown>;
    };

    expect(out.items).toEqual([]);
    expect(out.summary).toBeTruthy();
    expect(JSON.stringify(out.summary)).not.toContain('NaN');
  });

  it('reports each metric once something has been imported', async () => {
    await observe([
      { subject_ref: 'urn:li:share:1', metric: 'impressions', value: 1200, observed_at: day(1) },
      { subject_ref: 'urn:li:share:1', metric: 'engagements', value: 48, observed_at: day(1) },
    ]);

    const out = (await call('linkedin_analytics_query', { view: 'summary' })) as {
      summary: Record<string, unknown>;
    };

    expect(JSON.stringify(out.summary)).toContain('impressions');
  });
});

describe('the compare view', () => {
  it('reports both cohorts, the difference, and what not to conclude from it', async () => {
    await observe([
      { subject_ref: 'urn:li:share:a1', metric: 'impressions', value: 1000, observed_at: day(1) },
      { subject_ref: 'urn:li:share:a2', metric: 'impressions', value: 1100, observed_at: day(2) },
      { subject_ref: 'urn:li:share:b1', metric: 'impressions', value: 400, observed_at: day(3) },
      { subject_ref: 'urn:li:share:b2', metric: 'impressions', value: 500, observed_at: day(4) },
    ]);

    const out = (await call('linkedin_analytics_query', {
      view: 'compare',
      metric: 'impressions',
      cohort_a: ['urn:li:share:a1', 'urn:li:share:a2'],
      cohort_b: ['urn:li:share:b1', 'urn:li:share:b2'],
    })) as {
      comparison: {
        metric: string;
        cohort_a: { n: number; mean: number };
        cohort_b: { n: number; mean: number };
        difference: number;
        caveats: string[];
      };
    };

    expect(out.comparison.metric).toBe('impressions');
    expect(out.comparison.cohort_a.n).toBe(2);
    expect(out.comparison.cohort_b.n).toBe(2);
    expect(out.comparison.cohort_a.mean).toBeGreaterThan(out.comparison.cohort_b.mean);
    // Two posts against two is not evidence about anything, and the tool says
    // so rather than letting the number speak for itself.
    expect(out.comparison.caveats.length).toBeGreaterThan(0);
  });

  it('defaults to impressions when no metric is named', async () => {
    await observe([
      { subject_ref: 'urn:li:share:a1', metric: 'impressions', value: 1000, observed_at: day(1) },
      { subject_ref: 'urn:li:share:b1', metric: 'impressions', value: 400, observed_at: day(2) },
    ]);

    const out = (await call('linkedin_analytics_query', {
      view: 'compare',
      cohort_a: ['urn:li:share:a1'],
      cohort_b: ['urn:li:share:b1'],
    })) as { comparison: { metric: string } };

    expect(out.comparison.metric).toBe('impressions');
  });

  it('refuses a comparison with an empty side, rather than reporting one', async () => {
    // A cohort with nothing in it has no mean, and a difference against it
    // would be a number with no meaning at all.
    for (const cohorts of [
      { cohort_a: [], cohort_b: ['urn:li:share:b1'] },
      { cohort_a: ['urn:li:share:a1'], cohort_b: [] },
      { cohort_a: [], cohort_b: [] },
    ]) {
      await expect(
        call('linkedin_analytics_query', { view: 'compare', metric: 'impressions', ...cohorts }),
        JSON.stringify(cohorts),
      ).rejects.toThrow(/at least one subject_ref/i);
    }
  });

  it('reports a subject it has no observations for as an empty cohort, not an error', async () => {
    await observe([
      { subject_ref: 'urn:li:share:a1', metric: 'impressions', value: 1000, observed_at: day(1) },
    ]);

    const out = (await call('linkedin_analytics_query', {
      view: 'compare',
      metric: 'impressions',
      cohort_a: ['urn:li:share:a1'],
      cohort_b: ['urn:li:share:never-observed'],
    })) as { comparison: { cohort_b: { n: number }; caveats: string[] } };

    // Naming a post that has no numbers yet is an ordinary thing to do; the
    // caveats are where that shows up, not an exception.
    expect(out.comparison.cohort_b.n).toBe(0);
    expect(out.comparison.caveats.length).toBeGreaterThan(0);
  });
});

describe('the observations view', () => {
  it('pages against the table rather than a window', async () => {
    await observe(
      Array.from({ length: 5 }, (_, i) => ({
        subject_ref: `urn:li:share:${i}`,
        metric: 'impressions',
        value: 100 + i,
        observed_at: day(1),
      })),
    );

    const first = (await call('linkedin_analytics_query', { limit: 2 })) as {
      items: Array<{ id: string }>;
      has_more: boolean;
      next_cursor?: string;
    };

    expect(first.items).toHaveLength(2);
    // has_more is computed by fetching one extra row, so it is true because
    // there really is another one — not because a fixed window filled up.
    expect(first.has_more).toBe(true);
    if (!first.next_cursor) return;

    const second = (await call('linkedin_analytics_query', {
      limit: 2,
      cursor: first.next_cursor,
    })) as { items: Array<{ id: string }> };

    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items.some((i) => firstIds.has(i.id))).toBe(false);
  });

  it('says there is no more when the page is the last one', async () => {
    await observe([
      { subject_ref: 'urn:li:share:1', metric: 'impressions', value: 1, observed_at: day(1) },
    ]);

    const out = (await call('linkedin_analytics_query', { limit: 10 })) as {
      items: unknown[];
      has_more: boolean;
    };

    expect(out.items).toHaveLength(1);
    expect(out.has_more).toBe(false);
  });

  it('filters by subject and by metric', async () => {
    await observe([
      { subject_ref: 'urn:li:share:1', metric: 'impressions', value: 10, observed_at: day(1) },
      { subject_ref: 'urn:li:share:2', metric: 'engagements', value: 20, observed_at: day(1) },
    ]);

    const bySubject = (await call('linkedin_analytics_query', {
      subject_ref: 'urn:li:share:1',
    })) as { items: Array<{ subject_ref: string }> };
    for (const row of bySubject.items) expect(row.subject_ref).toBe('urn:li:share:1');

    const byMetric = (await call('linkedin_analytics_query', { metric: 'engagements' })) as {
      items: Array<{ metric: string }>;
    };
    for (const row of byMetric.items) expect(row.metric).toBe('engagements');
  });

  it('carries the retention class on every row', async () => {
    await observe([
      { subject_ref: 'urn:li:share:1', metric: 'impressions', value: 10, observed_at: day(1) },
    ]);

    const out = (await call('linkedin_analytics_query', {})) as {
      items: Array<{ retention_class: string }>;
    };

    // Retention class is what the sweep and the DMA purge read; a row without
    // one would sit in the database forever.
    expect(out.items[0]?.retention_class).toBeTruthy();
  });
});
