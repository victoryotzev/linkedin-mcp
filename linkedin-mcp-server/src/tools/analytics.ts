import * as z from 'zod/v4';
import {
  compareCohorts,
  importObservations,
  listObservations,
  metricsSummary,
} from '@linkedin-mcp/domain';
import type { AppContext } from '../bootstrap.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, decodeOffsetCursor, encodeOffsetCursor } from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

export function analyticsTools(ctx: AppContext): ToolDef[] {
  return [
    defineTool({
      name: 'linkedin_analytics_import',
      title: 'Import metric observations',
      description:
        "Record metrics the member transcribed from their own LinkedIn UI (impressions, reactions, comments, profile views, followers). LinkedIn's member-analytics APIs require Community Management access that individuals cannot obtain, so manual import is the supported path. Duplicate (subject, metric, timestamp) rows are skipped.",
      inputSchema: z.object({
        rows: z
          .array(
            z.object({
              subject_type: z.enum(['post', 'profile', 'follower']).default('post'),
              subject_ref: z.string().max(200),
              metric: z.string().max(60),
              value: z.number(),
              observed_at: z.string(),
              window_start: z.string().optional(),
              window_end: z.string().optional(),
              note: z.string().max(300).optional(),
            }),
          )
          .min(1)
          .max(500),
        provenance_artifact_id: z.string().optional(),
      }),
      outputSchema: z.object({
        imported: z.number(),
        duplicates: z.number(),
        rejected: z.array(z.object({ row: z.number(), reason: z.string() })),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ rows, provenance_artifact_id }) =>
        importObservations(ctx.db, rows, {
          source: 'manual_import',
          ...(provenance_artifact_id !== undefined ? { provenance_artifact_id } : {}),
        }),
    }),

    defineTool({
      name: 'linkedin_analytics_query',
      title: 'Query metrics and compare cohorts',
      description:
        'List observations, summarise metrics, or compare two groups of posts. Comparisons always return their sample size, mandatory confounders and a confidence label capped at "moderate" — a single account cannot support a causal claim.',
      inputSchema: z.object({
        view: z.enum(['observations', 'summary', 'compare']).default('observations'),
        subject_ref: z.string().optional(),
        metric: z.string().optional(),
        cohort_a: z.array(z.string()).optional(),
        cohort_b: z.array(z.string()).optional(),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            subject_type: z.string(),
            subject_ref: z.string(),
            metric: z.string(),
            value: z.number(),
            observed_at: z.string(),
            source: z.string(),
            retention_class: z.string(),
          }),
        ),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
        summary: z
          .array(z.object({ metric: z.string(), observations: z.number(), subjects: z.number() }))
          .optional(),
        comparison: z
          .object({
            metric: z.string(),
            cohort_a: z.object({ n: z.number(), mean: z.number().nullable() }),
            cohort_b: z.object({ n: z.number(), mean: z.number().nullable() }),
            difference: z.number().nullable(),
            confidence: z.string(),
            caveats: z.array(z.string()),
          })
          .optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async ({ view, subject_ref, metric, cohort_a, cohort_b, cursor, limit }) => {
        if (view === 'summary') {
          return { items: [], has_more: false, summary: metricsSummary(ctx.db) };
        }
        if (view === 'compare') {
          const comparison = compareCohorts(ctx.db, {
            metric: metric ?? 'impressions',
            cohort_a: cohort_a ?? [],
            cohort_b: cohort_b ?? [],
          });
          return {
            items: [],
            has_more: false,
            comparison: {
              metric: comparison.metric,
              cohort_a: { n: comparison.cohort_a.n, mean: comparison.cohort_a.mean },
              cohort_b: { n: comparison.cohort_b.n, mean: comparison.cohort_b.mean },
              difference: comparison.difference,
              confidence: comparison.confidence,
              caveats: comparison.caveats,
            },
          };
        }
        // Offset pushed into SQL and one extra row fetched, so has_more is
        // computed against the real table rather than against a 200-row window
        // that made every later observation unreachable.
        const offset = decodeOffsetCursor(cursor);
        const rows = listObservations(ctx.db, {
          ...(subject_ref !== undefined ? { subject_ref } : {}),
          ...(metric !== undefined ? { metric } : {}),
          limit: limit + 1,
          offset,
        }).map((o) => ({
          id: o.id,
          subject_type: o.subject_type,
          subject_ref: o.subject_ref,
          metric: o.metric,
          value: o.value,
          observed_at: o.observed_at,
          source: o.source,
          retention_class: o.retention_class,
        }));
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return {
          items,
          has_more: hasMore,
          ...(hasMore ? { next_cursor: encodeOffsetCursor(offset + items.length) } : {}),
        };
      },
    }),
  ];
}
