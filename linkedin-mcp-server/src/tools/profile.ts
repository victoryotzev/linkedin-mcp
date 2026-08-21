import * as z from 'zod/v4';
import { ArtifactStore } from '@linkedin-mcp/db';
import {
  CANONICAL_SECTIONS,
  diffProfile,
  getProfile,
  importSnapshot,
  listSnapshots,
  scoreProfile,
  updateSection,
  type DiffRef,
} from '@linkedin-mcp/domain';
import { join } from 'node:path';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, pageFromArray } from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const sectionKey = z.enum(CANONICAL_SECTIONS);
const diffRef = z
  .string()
  .regex(/^(canonical|snapshot:[A-Za-z0-9_]+|snapshot:latest)$/)
  .describe("'canonical', 'snapshot:latest', or 'snapshot:<id>'");

const revisionShape = z.object({
  id: z.string(),
  section_key: z.string(),
  content_text: z.string(),
  content_hash: z.string(),
  based_on_revision: z.string().nullable(),
  claim_ids: z.array(z.string()),
  rationale: z.string().nullable(),
  author: z.string(),
  created_at: z.string(),
});

export function profileTools(ctx: AppContext): ToolDef[] {
  const store = new ArtifactStore(join(ctx.home, 'artifacts'));
  const actor = contextActor(ctx);

  return [
    defineTool({
      name: 'linkedin_profile_get',
      title: 'Get canonical profile',
      description:
        'The LOCAL canonical profile: evidence-backed sections this app holds as authoritative (append-only revisions; null = never written), plus the snapshot index. This is not a live LinkedIn read and makes no claim about what linkedin.com currently shows. linkedin_profile_read_latest does call LinkedIn, but it reads the Data Portability Snapshot, which can lag behind the live site and never states how far — no tool here can report what linkedin.com shows right now.',
      inputSchema: z.object({
        sections: z.array(sectionKey).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      }),
      outputSchema: z.object({
        sections: z.record(z.string(), revisionShape.nullable()),
        snapshots: z.array(
          z.object({
            id: z.string(),
            source_kind: z.string(),
            version: z.number(),
            imported_at: z.string(),
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
      handler: async ({ sections, cursor, limit }) => {
        const snapshots = pageFromArray(
          listSnapshots(ctx.db).map((s) => ({
            id: s.id,
            source_kind: s.source_kind,
            version: s.version,
            imported_at: s.imported_at,
          })),
          cursor,
          limit,
        );
        return {
          sections: getProfile(ctx.db, sections) as never,
          snapshots: snapshots.items,
          has_more: snapshots.has_more,
          ...(snapshots.next_cursor !== undefined ? { next_cursor: snapshots.next_cursor } : {}),
        };
      },
    }),

    defineTool({
      name: 'linkedin_profile_update',
      title: 'Update canonical section',
      description:
        'Append a new revision of a canonical section (headline, about, experience, ..., audiences, positioning_brief, keyword_map). Every cited claim must be VERIFIED; based_on_revision enforces optimistic concurrency (pass the current revision id, or null for a first write).',
      inputSchema: z.object({
        section_key: sectionKey,
        content_text: z.string().min(1).max(20_000),
        claim_ids: z.array(z.string()).default([]),
        rationale: z.string().max(1000).optional(),
        based_on_revision: z.string().nullable().default(null),
      }),
      outputSchema: z.object({ revision: revisionShape }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ section_key, content_text, claim_ids, rationale, based_on_revision }) => ({
        revision: updateSection(ctx.db, {
          section_key,
          content_text,
          claim_ids,
          author: actor === 'dashboard' ? 'user' : 'mcp_host',
          based_on_revision,
          ...(rationale !== undefined ? { rationale } : {}),
        }),
      }),
    }),

    defineTool({
      name: 'linkedin_snapshot_import',
      title: 'Import LinkedIn snapshot',
      description:
        'Parse an imported LinkedIn source (linkedin_export archive or profile-PDF document) into a versioned snapshot with normalized fields for diffing. Import the source with linkedin_import_run first.',
      inputSchema: z.object({
        source_id: z.string(),
        taken_at: z.string().optional().describe('when LinkedIn generated this data (ISO)'),
      }),
      outputSchema: z.object({
        snapshot_id: z.string(),
        version: z.number(),
        field_count: z.number(),
        fields: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ source_id, taken_at }) => {
        const snapshot = importSnapshot(ctx.db, store, source_id, taken_at);
        return {
          snapshot_id: snapshot.id,
          version: snapshot.version,
          field_count: Object.keys(snapshot.fields).length,
          fields: Object.keys(snapshot.fields).sort(),
          warnings: snapshot.warnings,
        };
      },
    }),

    defineTool({
      name: 'linkedin_profile_diff',
      title: 'Diff profile states',
      description:
        "Field-level diff between profile states: 'canonical', 'snapshot:latest', or 'snapshot:<id>'. Snapshot fields are mapped onto canonical section keys.",
      inputSchema: z.object({ left: diffRef, right: diffRef }),
      outputSchema: z.object({
        fields: z.array(
          z.object({
            field_key: z.string(),
            left_text: z.string().nullable(),
            right_text: z.string().nullable(),
            left_chars: z.number(),
            right_chars: z.number(),
            changed: z.boolean(),
          }),
        ),
        changed_count: z.number(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async ({ left, right }) => {
        const fields = diffProfile(ctx.db, left as DiffRef, right as DiffRef);
        return { fields, changed_count: fields.filter((f) => f.changed).length };
      },
    }),

    defineTool({
      name: 'linkedin_profile_score',
      title: 'Score the profile',
      description:
        'Explained profile scores — completeness, evidence coverage, freshness — as transparent ratios with per-finding details. Recomputed deterministically on demand (no fake precision, no persistence). Keyword-alignment scoring activates once a positioning_brief section exists.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        findings: z.array(
          z.object({
            dimension: z.string(),
            score: z.number(),
            explanation: z.string(),
            details: z.array(z.string()),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async () => ({ findings: scoreProfile(ctx.db) }),
    }),
  ];
}
