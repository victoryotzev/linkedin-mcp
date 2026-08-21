import * as z from 'zod/v4';
import { ArtifactStore } from '@linkedin-mcp/db';
import {
  exportBundle,
  listBackups,
  purgeArtifact,
  dmaLaneFootprint,
  purgeDmaLane,
  runBackup,
  runRetentionSweep,
  verifyManagedBackup,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { join } from 'node:path';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { pageFromArray } from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

export function maintenanceTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);
  const store = new ArtifactStore(join(ctx.home, 'artifacts'));

  return [
    defineTool({
      name: 'linkedin_backup_run',
      title: 'Back up or export',
      description:
        "Create a verified backup (online SQLite snapshot + artifacts + hash manifest) inside the managed data directory, or produce an export bundle of the member's own data. There is no path parameter: backups only ever land in the managed location. Secrets are never included.",
      inputSchema: z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('backup'),
          label: z
            .string()
            .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/)
            .optional(),
        }),
        z.object({ mode: z.literal('verify'), backup_name: z.string().min(1).max(120) }),
        z.object({
          mode: z.literal('list'),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(25),
        }),
        z.object({ mode: z.literal('export_bundle') }),
      ]),
      outputSchema: z.object({
        mode: z.string(),
        backup_name: z.string().optional(),
        entries: z.number().optional(),
        total_bytes: z.number().optional(),
        backups: z
          .array(
            z.object({
              name: z.string(),
              created_at: z.string(),
              entries: z.number(),
              total_bytes: z.number(),
            }),
          )
          .optional(),
        has_more: z.boolean().optional(),
        next_cursor: z.string().optional(),
        verification: z
          .object({ valid: z.boolean(), checked: z.number(), problems: z.array(z.string()) })
          .optional(),
        bundle: z
          .object({
            claims: z.number(),
            canonical_sections: z.number(),
            drafts: z.number(),
            observations: z.number(),
            note: z.string(),
          })
          .optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        const { mode } = input;
        if (mode === 'verify') {
          return {
            mode,
            backup_name: input.backup_name,
            verification: verifyManagedBackup(ctx.home, input.backup_name),
          };
        }
        if (mode === 'list') {
          const page = pageFromArray(listBackups(ctx.home), input.cursor, input.limit);
          return {
            mode,
            backups: page.items,
            has_more: page.has_more,
            ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
          };
        }
        if (mode === 'export_bundle') {
          const bundle = exportBundle(ctx.db);
          return {
            mode,
            bundle: {
              claims: bundle.claims.length,
              canonical_sections: bundle.canonical_sections.length,
              drafts: bundle.drafts.length,
              observations: bundle.observations.length,
              note: bundle.note,
            },
          };
        }
        const result = await runBackup(ctx.db, ctx.home, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          actor,
        });
        // A backup that does not verify is not a backup.
        const verification = verifyManagedBackup(ctx.home, result.name);
        return {
          mode,
          backup_name: result.name,
          entries: result.entries,
          total_bytes: result.total_bytes,
          verification,
        };
      },
    }),

    defineTool({
      name: 'linkedin_purge_run',
      title: 'Run retention sweep or purge an artifact',
      description:
        'Run retention, permanently delete one uncited artifact, prune or delete EU Data Portability data, or schedule a full local purge. prune_dma drops portability history older than a cutoff while keeping the current observed profile; purge_dma deletes the portability lane outright, which is how a member exercises deletion of their Portability Data without destroying their claims, drafts and audit history. Full purge requires the exact phrase, explicit acceptance when no verified backup exists, and shuts down the current MCP/dashboard process after responding.',
      inputSchema: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('retention_sweep') }),
        z.object({
          mode: z.literal('purge_artifact'),
          artifact_id: z.string().min(1),
          confirm: z.literal(true),
        }),
        z.object({
          mode: z.literal('prune_dma'),
          before: z
            .string()
            .min(1)
            .describe('ISO timestamp; portability rows recorded before it are removed'),
          confirm: z.literal(true),
        }),
        z.object({
          mode: z.literal('purge_dma'),
          confirm_phrase: z.literal('DELETE LINKEDIN PORTABILITY DATA'),
          confirm: z.literal(true),
        }),
        z.object({
          mode: z.literal('purge_all'),
          confirm_phrase: z.literal('DELETE ALL LOCAL DATA'),
          accept_no_backup: z.boolean().default(false),
          confirm: z.literal(true),
        }),
      ]),
      outputSchema: z.object({
        mode: z.string(),
        sweep: z
          .object({
            state_handles_removed: z.number(),
            claims_expired: z.number(),
            observations_expired: z.number(),
            swept_at: z.string(),
            dma_lane: z.object({
              changelog_events: z.number(),
              snapshot_observations: z.number(),
              snapshot_domain_results: z.number(),
              dma_snapshots: z.number(),
              snapshot_fields: z.number(),
              published_posts: z.number(),
              raw_payload_bytes: z.number(),
            }),
          })
          .optional(),
        purged: z
          .object({
            artifact_id: z.string(),
            source_relpath: z.string(),
            extractions_removed: z.number(),
            bytes_deleted: z.boolean(),
          })
          .optional(),
        dma: z
          .object({
            mode: z.enum(['prune', 'purge']),
            before: z.string().nullable(),
            deleted: z.object({
              changelog_events: z.number(),
              snapshot_observations: z.number(),
              snapshot_domain_results: z.number(),
              dma_snapshots: z.number(),
              snapshot_fields: z.number(),
              published_posts: z.number(),
              raw_payload_bytes: z.number(),
            }),
            retained_snapshots: z.array(z.object({ snapshot_id: z.string(), reason: z.string() })),
            fully_deleted: z.boolean(),
            cursor_reset: z.boolean(),
            purged_at: z.string(),
          })
          .optional(),
        status: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        if (input.mode === 'purge_all') {
          if (!ctx.scheduleFullPurge) {
            throw new DomainError(
              'CAPABILITY_UNAVAILABLE',
              'full purge shutdown hook is unavailable in this process',
            );
          }
          const hasVerifiedBackup = listBackups(ctx.home).some((backup) => {
            try {
              return verifyManagedBackup(ctx.home, backup.name).valid;
            } catch {
              return false;
            }
          });
          if (!hasVerifiedBackup && !input.accept_no_backup) {
            throw new DomainError(
              'INVALID_INPUT',
              'no verified backup exists; create and verify one first, or explicitly set accept_no_backup=true',
            );
          }
          ctx.scheduleFullPurge();
          return { mode: input.mode, status: 'purging' };
        }
        if (input.mode === 'prune_dma' || input.mode === 'purge_dma') {
          return {
            mode: input.mode,
            dma: purgeDmaLane(ctx.db, {
              ...(input.mode === 'prune_dma' ? { before: input.before } : {}),
              confirm: input.confirm,
              actor,
            }),
          };
        }
        if (input.mode === 'purge_artifact') {
          return {
            mode: input.mode,
            purged: purgeArtifact(ctx.db, store, input.artifact_id, input.confirm),
          };
        }
        // The footprint rides along so the size of what purge_dma would delete
        // is visible before deleting it, which is what the README promises.
        return {
          mode: input.mode,
          sweep: { ...runRetentionSweep(ctx.db), dma_lane: dmaLaneFootprint(ctx.db) },
        };
      },
    }),
  ];
}
