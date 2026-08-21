import * as z from 'zod/v4';
import { ArtifactStore } from '@linkedin-mcp/db';
import {
  contentOpportunities,
  getPillar,
  currentRevision,
  getDraft,
  importPublishedPosts,
  latestValidation,
  listCalendar,
  listDrafts,
  listPillars,
  upsertCalendarEntry,
  upsertPillar,
  validateDraft,
  voiceProfile,
  writeDraft,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { join } from 'node:path';
import type { AppContext } from '../bootstrap.ts';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeOffsetCursor,
  encodeOffsetCursor,
  pageFromArray,
} from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

const checkShape = z.object({
  check: z.string(),
  passed: z.boolean(),
  detail: z.string(),
  offenders: z.array(z.string()),
});

export function contentTools(ctx: AppContext): ToolDef[] {
  const store = new ArtifactStore(join(ctx.home, 'artifacts'));

  return [
    defineTool({
      name: 'linkedin_content_opportunities',
      title: 'Post ideas from verified claims',
      description:
        'Rank verified claims by novelty — how little they overlap with what has already been published or drafted. Each idea carries its claim id and any allowed-wording limitations, so a draft can cite it directly.',
      inputSchema: z.object({
        pillar_id: z
          .string()
          .optional()
          .describe(
            'Tags every returned opportunity with this content pillar. It does NOT filter — claims are not assigned to pillars, so there is nothing to filter on. The id is validated, so a typo is refused rather than silently ignored.',
          ),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            claim_id: z.string(),
            statement: z.string(),
            limitations: z.string().nullable(),
            novelty: z.number(),
            closest_prior: z.string().nullable(),
          }),
        ),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async ({ pillar_id, cursor, limit }) => {
        // Validated so a wrong id is an error rather than a silently-ignored
        // parameter. getPillar throws NOT_FOUND.
        if (pillar_id !== undefined) getPillar(ctx.db, pillar_id);
        const offset = decodeOffsetCursor(cursor);
        const window = contentOpportunities(ctx.db, {
          ...(pillar_id !== undefined ? { pillar_id } : {}),
          offset,
          limit: limit + 1,
        });
        const items = window
          .slice(0, limit)
          .map(({ claim_id, statement, limitations, novelty, closest_prior }) => ({
            claim_id,
            statement,
            limitations,
            novelty,
            closest_prior,
          }));
        const hasMore = window.length > limit;
        return {
          items,
          has_more: hasMore,
          ...(hasMore ? { next_cursor: encodeOffsetCursor(offset + items.length) } : {}),
        };
      },
    }),

    defineTool({
      name: 'linkedin_voice_profile',
      title: 'Voice profile from published history',
      description:
        "Descriptive statistics of the member's own published posts (length, language mix, hashtag habits, cadence). Use it to match how they actually write instead of inventing a tone. Import the history first with linkedin_published_import.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        posts: z.number(),
        first_post: z.string().nullable(),
        last_post: z.string().nullable(),
        median_chars: z.number(),
        language_mix: z.record(z.string(), z.number()),
        hashtags_per_post: z.number(),
        top_hashtags: z.array(z.object({ tag: z.string(), count: z.number() })),
        posts_with_link: z.number(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async () => voiceProfile(ctx.db),
    }),

    defineTool({
      name: 'linkedin_published_import',
      title: 'Import published post history',
      description:
        "Parse the Shares file of an imported LinkedIn export into the member's own published-post history (used for repetition checks and the voice profile).",
      inputSchema: z.object({ artifact_id: z.string() }),
      outputSchema: z.object({ imported: z.number(), skipped: z.number() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ artifact_id }) => importPublishedPosts(ctx.db, store, artifact_id),
    }),

    defineTool({
      name: 'linkedin_draft_write',
      title: 'Create or revise a draft',
      description:
        'Create a post draft or append a new revision. Revisions are append-only and every write drops the draft back to "draft" state, invalidating any earlier validation — text and approval are always bound to one revision hash.',
      inputSchema: z.object({
        draft_id: z.string().optional(),
        slug: z.string().max(80).optional(),
        body_text: z.string().min(1).max(20_000),
        media: z.array(z.object({ artifact_id: z.string(), alt: z.string().max(300) })).optional(),
        visibility: z.enum(['PUBLIC', 'CONNECTIONS']).default('PUBLIC'),
        pillar_id: z.string().optional(),
      }),
      outputSchema: z.object({
        draft_id: z.string(),
        slug: z.string(),
        state: z.string(),
        revision: z.number(),
        revision_hash: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ draft_id, slug, body_text, media, visibility, pillar_id }) => {
        const { draft, revision } = writeDraft(ctx.db, {
          ...(draft_id !== undefined ? { draft_id } : {}),
          ...(slug !== undefined ? { slug } : {}),
          body_text,
          ...(media !== undefined ? { media } : {}),
          visibility,
          ...(pillar_id !== undefined ? { pillar_id } : {}),
        });
        return {
          draft_id: draft.id,
          slug: draft.slug,
          state: draft.state,
          revision: revision.revision,
          revision_hash: revision.revision_hash,
        };
      },
    }),

    defineTool({
      name: 'linkedin_draft_list',
      title: 'List / inspect drafts',
      description:
        'List drafts, or with id return the current revision text, its latest validation report and the exact preview that a publication approval would bind to.',
      inputSchema: z.object({
        id: z.string().optional(),
        state: z.enum(['draft', 'validated', 'approved', 'published', 'abandoned']).optional(),
        pillar_id: z.string().optional(),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            slug: z.string(),
            state: z.string(),
            current_revision: z.number(),
            current_revision_hash: z.string().nullable(),
            updated_at: z.string(),
          }),
        ),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
        detail: z
          .object({
            body_text: z.string(),
            visibility: z.string(),
            media: z.array(z.object({ artifact_id: z.string(), alt: z.string() })),
            revision_hash: z.string(),
            validation: z
              .object({
                passed: z.boolean(),
                revision_hash: z.string(),
                stale: z.boolean(),
                checks: z.array(checkShape),
              })
              .nullable(),
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
      handler: async ({ id, state, pillar_id, cursor, limit }) => {
        if (id) {
          const draft = getDraft(ctx.db, id);
          const revision = currentRevision(ctx.db, id);
          const validation = latestValidation(ctx.db, id);
          return {
            items: [
              {
                id: draft.id,
                slug: draft.slug,
                state: draft.state,
                current_revision: draft.current_revision,
                current_revision_hash: draft.current_revision_hash,
                updated_at: draft.updated_at,
              },
            ],
            has_more: false,
            detail: {
              body_text: revision.body_text,
              visibility: revision.visibility,
              media: revision.media,
              revision_hash: revision.revision_hash,
              validation: validation
                ? {
                    passed: validation.passed,
                    revision_hash: validation.revision_hash,
                    stale: validation.revision_hash !== revision.revision_hash,
                    checks: validation.checks,
                  }
                : null,
            },
          };
        }
        const all = listDrafts(ctx.db, {
          ...(state !== undefined ? { state } : {}),
          ...(pillar_id !== undefined ? { pillar_id } : {}),
        }).map((d) => ({
          id: d.id,
          slug: d.slug,
          state: d.state,
          current_revision: d.current_revision,
          current_revision_hash: d.current_revision_hash,
          updated_at: d.updated_at,
        }));
        return pageFromArray(all, cursor, limit);
      },
    }),

    defineTool({
      name: 'linkedin_draft_validate',
      title: 'Validate a draft',
      description:
        'Run the deterministic gates on the current revision: evidence coverage (unsupported sentences block), secret leakage, fabricated metrics (quantities absent from verified claims), repetition against published posts and other drafts, filler language, character limit and link shape. Passing moves the draft to "validated".',
      inputSchema: z.object({ draft_id: z.string() }),
      outputSchema: z.object({
        report_id: z.string(),
        draft_id: z.string(),
        revision_hash: z.string(),
        passed: z.boolean(),
        checks: z.array(checkShape),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ draft_id }) => {
        const report = validateDraft(ctx.db, draft_id);
        return {
          report_id: report.id,
          draft_id: report.draft_id,
          revision_hash: report.revision_hash,
          passed: report.passed,
          checks: report.checks,
        };
      },
    }),

    defineTool({
      name: 'linkedin_calendar_plan',
      title: 'Plan pillars and calendar',
      description:
        'Create or update content pillars and calendar entries, or list them. Planning metadata only — nothing is ever published from a date; publishing always requires an explicit human approval.',
      inputSchema: z.object({
        action: z.enum(['list', 'upsert_pillar', 'upsert_entry']),
        pillar_id: z.string().nullable().optional(),
        name: z.string().max(80).optional(),
        description: z.string().max(1000).optional(),
        audience: z.string().max(200).optional(),
        entry_id: z.string().optional(),
        draft_id: z.string().nullable().optional(),
        intended_date: z.string().optional(),
        status: z.enum(['planned', 'drafted', 'approved', 'published', 'skipped']).optional(),
        note: z.string().max(500).nullable().optional(),
      }),
      outputSchema: z.object({
        pillars: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullable(),
            audience: z.string().nullable(),
            status: z.string(),
          }),
        ),
        entries: z.array(
          z.object({
            id: z.string(),
            draft_id: z.string().nullable(),
            pillar_id: z.string().nullable(),
            intended_date: z.string(),
            status: z.string(),
            note: z.string().nullable(),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        if (input.action === 'upsert_pillar') {
          if (!input.name) throw new DomainError('INVALID_INPUT', 'upsert_pillar requires name');
          upsertPillar(ctx.db, {
            ...(typeof input.pillar_id === 'string' ? { id: input.pillar_id } : {}),
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.audience !== undefined ? { audience: input.audience } : {}),
          });
        } else if (input.action === 'upsert_entry') {
          if (!input.entry_id && !input.intended_date) {
            throw new DomainError('INVALID_INPUT', 'upsert_entry requires intended_date');
          }
          upsertCalendarEntry(ctx.db, {
            ...(input.entry_id !== undefined ? { id: input.entry_id } : {}),
            ...(input.draft_id !== undefined ? { draft_id: input.draft_id } : {}),
            ...(input.pillar_id !== undefined ? { pillar_id: input.pillar_id } : {}),
            intended_date: input.intended_date,
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          });
        }
        return { pillars: listPillars(ctx.db), entries: listCalendar(ctx.db) };
      },
    }),
  ];
}
