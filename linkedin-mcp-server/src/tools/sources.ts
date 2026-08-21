import * as z from 'zod/v4';
import { ArtifactStore } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import {
  SOURCE_KINDS,
  SOURCE_TRUSTS,
  enableSourceFromDashboard,
  getArtifactDetail,
  listArtifacts,
  listSources,
  registerSource,
  restrictSource,
  runImport,
} from '@linkedin-mcp/domain';
import { join } from 'node:path';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, pageFromArray } from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

const sourceShape = z.object({
  id: z.string(),
  kind: z.string(),
  root_path: z.string(),
  label: z.string(),
  trust: z.string(),
  status: z.string(),
  registered_at: z.string(),
  enabled_at: z.string().nullable(),
  last_import_at: z.string().nullable(),
  notes: z.string().nullable(),
});

export function sourceTools(ctx: AppContext): ToolDef[] {
  const store = new ArtifactStore(join(ctx.home, 'artifacts'));
  const actor = contextActor(ctx);

  return [
    defineTool({
      name: 'linkedin_source_manage',
      title: 'Manage evidence sources',
      description:
        "Register, enable, disable, or archive an evidence source root. Registration lands in 'pending_review'. Enabling filesystem access requires confirm:true and the exact command ENABLE <source_id> after the user reviews the path and trust class.",
      inputSchema: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('register'),
          path: z.string().describe('absolute path of the source root (file or directory)'),
          kind: z.enum(SOURCE_KINDS),
          trust: z
            .enum(SOURCE_TRUSTS)
            .describe("'local_clone_reference' sources can never back authorship claims"),
          label: z.string().min(1).max(120),
          notes: z.string().max(2000).optional(),
        }),
        z.object({
          action: z.literal('enable'),
          source_id: z.string(),
          command: z.string().describe('exactly: ENABLE <source_id>'),
          confirm: z.literal(true),
        }),
        z.object({ action: z.enum(['disable', 'archive']), source_id: z.string() }),
      ]),
      outputSchema: z.object({ source: sourceShape }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        if (input.action === 'register') {
          const source = registerSource(ctx.db, {
            path: input.path,
            kind: input.kind,
            trust: input.trust,
            label: input.label,
            dataHome: ctx.home,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          });
          return { source };
        }
        if (input.action === 'enable') {
          const expected = `ENABLE ${input.source_id}`;
          if (input.command !== expected) {
            throw invalid(`explicit confirmation required; command must be: ${expected}`);
          }
          return { source: enableSourceFromDashboard(ctx.db, input.source_id, actor) };
        }
        return { source: restrictSource(ctx.db, input.source_id, input.action) };
      },
    }),

    defineTool({
      name: 'linkedin_source_list',
      title: 'List evidence sources',
      description: 'List registered evidence sources with status and import stats.',
      inputSchema: z.object({
        status: z.string().optional(),
        kind: z.string().optional(),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(sourceShape),
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
      handler: async ({ status, kind, cursor, limit }) =>
        pageFromArray(
          listSources(ctx.db, {
            ...(status !== undefined ? { status } : {}),
            ...(kind !== undefined ? { kind } : {}),
          }),
          cursor,
          limit,
        ),
    }),

    defineTool({
      name: 'linkedin_import_run',
      title: 'Import from a source',
      description:
        'Copy files from an ENABLED source into the immutable content-addressed store (originals are never moved), extract text with secret redaction, dedup by hash, and supersede changed files. Per-file failures become reject entries; the run continues. LinkedIn-export archives skip third-party-PII files by default.',
      inputSchema: z.object({
        source_id: z.string(),
        dry_run: z.boolean().default(false),
        subpath: z
          .string()
          .optional()
          .describe('folder sources only: restrict to a root-relative subtree'),
      }),
      outputSchema: z.object({
        run_id: z.string(),
        source_id: z.string(),
        dry_run: z.boolean(),
        files_seen: z.number(),
        files_imported: z.number(),
        files_skipped_dup: z.number(),
        files_rejected: z.number(),
        rejects: z.array(z.object({ relpath: z.string(), reason: z.string() })),
        new_artifact_ids: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ source_id, dry_run, subpath }) => {
        const report = await runImport(ctx.db, store, source_id, {
          dryRun: dry_run,
          ...(subpath !== undefined ? { subpath } : {}),
        });
        return { ...report, rejects: report.rejects.slice(0, 50) };
      },
    }),

    defineTool({
      name: 'linkedin_artifact_list',
      title: 'List / inspect artifacts',
      description:
        'List imported artifacts (filter by source, mime, or full-text query). With id+detail, returns metadata plus a capped text preview wrapped in an UNTRUSTED-content envelope, after hash-verifying the stored bytes (fails closed on tampering).',
      inputSchema: z.object({
        id: z.string().optional(),
        detail: z.boolean().default(false),
        source_id: z.string().optional(),
        mime: z.string().optional(),
        q: z.string().max(200).optional().describe('full-text search over extracted text'),
        include_superseded: z.boolean().default(false),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            source_id: z.string(),
            source_relpath: z.string(),
            sha256: z.string(),
            size_bytes: z.number(),
            mime: z.string(),
            imported_at: z.string(),
            superseded: z.boolean(),
            extraction_status: z.string().nullable(),
            contains_secrets: z.boolean(),
          }),
        ),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
        detail: z
          .object({
            integrity_verified: z.boolean(),
            parser: z.string().nullable(),
            extraction_error: z.string().nullable(),
            preview: z.string().nullable(),
            preview_truncated: z.boolean(),
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
      handler: async ({ id, detail, source_id, mime, q, include_superseded, cursor, limit }) => {
        // `id` now selects the artifact whether or not `detail` is set; detail
        // only controls whether the preview block comes with it. Previously an
        // `id` without `detail:true` fell through to the unfiltered list, so
        // the caller silently got every artifact instead of the one they named.
        if (id) {
          const full = getArtifactDetail(ctx.db, store, id);
          const {
            integrity_verified,
            parser,
            extraction_error,
            preview,
            preview_truncated,
            ...summary
          } = full;
          return {
            items: [summary],
            has_more: false,
            ...(detail
              ? {
                  detail: {
                    integrity_verified,
                    parser,
                    extraction_error,
                    preview,
                    preview_truncated,
                  },
                }
              : {}),
          };
        }
        const all = listArtifacts(
          ctx.db,
          {
            ...(source_id !== undefined ? { source_id } : {}),
            ...(mime !== undefined ? { mime } : {}),
            ...(q !== undefined ? { q } : {}),
            include_superseded,
          },
          ctx.fts5,
        );
        return pageFromArray(all, cursor, limit);
      },
    }),
  ];
}

function invalid(message: string): DomainError {
  return new DomainError('INVALID_INPUT', message);
}
