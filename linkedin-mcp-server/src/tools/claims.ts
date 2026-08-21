import * as z from 'zod/v4';
import {
  checkCoverage,
  detectConflicts,
  getClaim,
  getClaimEvidence,
  listClaims,
  listConflicts,
  markClaimAmbiguous,
  mergeClaim,
  proposeClaim,
  rejectClaim,
  resolveConflict,
  verifyClaim,
  type Claim,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, pageFromArray } from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

const claimManageInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('propose'),
    statement: z.string().min(8).max(500),
    evidence: z
      .array(
        z.object({
          artifact_id: z.string(),
          extraction_id: z.string().optional(),
          location: z.record(z.string(), z.unknown()).default({}),
          role: z.enum(['primary', 'corroborating']).default('primary'),
        }),
      )
      .min(1),
    method: z.enum(['parser', 'model_proposed', 'manual']),
    confidence: z.number().min(0).max(1).optional(),
    limitations: z.string().max(500).optional(),
    sensitivity: z.enum(['public', 'internal', 'sensitive']).optional(),
    review_by: z.string().optional(),
  }),
  z.object({
    action: z.literal('verify'),
    claim_id: z.string(),
    confirm: z.literal(true),
    limitations: z.string().max(500).optional(),
    review_by: z.string().optional(),
    clone_reference_ack: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('reject'),
    claim_id: z.string(),
    reason: z.string().min(3).max(500),
    confirm: z.literal(true),
  }),
  z.object({
    action: z.literal('mark_ambiguous'),
    claim_id: z.string(),
    reason: z.string().max(500).optional(),
    confirm: z.literal(true),
  }),
  z.object({
    action: z.literal('merge'),
    claim_id: z.string(),
    merge_into: z.string(),
    confirm: z.literal(true),
  }),
]);

const claimShape = z.object({
  id: z.string(),
  statement: z.string(),
  state: z.string(),
  method: z.string(),
  confidence: z.number().nullable(),
  limitations: z.string().nullable(),
  sensitivity: z.string(),
  review_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  rejected_reason: z.string().nullable(),
  created_at: z.string(),
});

function publicClaim(c: Claim) {
  return {
    id: c.id,
    statement: c.statement,
    state: c.state,
    method: c.method,
    confidence: c.confidence,
    limitations: c.limitations,
    sensitivity: c.sensitivity,
    review_by: c.review_by,
    reviewed_at: c.reviewed_at,
    rejected_reason: c.rejected_reason,
    created_at: c.created_at,
  };
}

export function claimTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);
  return [
    defineTool({
      name: 'linkedin_claim_list',
      title: 'List / inspect claims',
      description:
        'Search the evidence ledger. Filters: state, stale (verified past review_by), sensitivity, artifact, full-text. With id set, returns the claim plus its evidence locations.',
      inputSchema: z.object({
        id: z.string().optional(),
        state: z.enum(['candidate', 'verified', 'ambiguous', 'rejected', 'expired']).optional(),
        stale: z.boolean().default(false),
        sensitivity: z.enum(['public', 'internal', 'sensitive']).optional(),
        artifact_id: z.string().optional(),
        q: z.string().max(200).optional(),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(claimShape),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
        evidence: z
          .array(
            z.object({
              artifact_id: z.string(),
              source_relpath: z.string(),
              source_label: z.string(),
              source_trust: z.string(),
              location: z.record(z.string(), z.unknown()),
              role: z.string(),
            }),
          )
          .optional(),
        counts_by_state: z.record(z.string(), z.number()).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async ({ id, state, stale, sensitivity, artifact_id, q, cursor, limit }) => {
        if (id) {
          const claim = getClaim(ctx.db, id);
          return {
            items: [publicClaim(claim)],
            has_more: false,
            evidence: getClaimEvidence(ctx.db, id),
          };
        }
        const all = listClaims(
          ctx.db,
          {
            ...(state !== undefined ? { state } : {}),
            ...(stale ? { stale } : {}),
            ...(sensitivity !== undefined ? { sensitivity } : {}),
            ...(artifact_id !== undefined ? { artifact_id } : {}),
            ...(q !== undefined ? { q } : {}),
          },
          ctx.fts5,
        );
        const counts: Record<string, number> = {};
        for (const c of all) counts[c.state] = (counts[c.state] ?? 0) + 1;
        const page = pageFromArray(all.map(publicClaim), cursor, limit);
        return { ...page, counts_by_state: counts };
      },
    }),

    defineTool({
      name: 'linkedin_claim_manage',
      title: 'Claim lifecycle',
      description:
        'Propose, verify, reject, mark_ambiguous, or merge claims. Verification and rejection are HUMAN decisions: verify requires confirm:true after the user has reviewed the evidence (>=1 primary link required; authorship-shaped statements cannot cite local_clone_reference sources). Rejections persist as permanent tombstones that block resurrection.',
      inputSchema: claimManageInput,
      outputSchema: z.object({
        claim: claimShape,
        conflicts_created: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: false,
        // The union includes permanent rejection tombstones and merges.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        let claim: ReturnType<typeof proposeClaim>;
        switch (input.action) {
          case 'propose': {
            claim = proposeClaim(ctx.db, {
              statement: input.statement,
              evidence: input.evidence,
              method: input.method,
              ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
              ...(input.limitations !== undefined ? { limitations: input.limitations } : {}),
              ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
              ...(input.review_by !== undefined ? { review_by: input.review_by } : {}),
            });
            break;
          }
          case 'verify': {
            if (!input.claim_id) throw new DomainError('INVALID_INPUT', 'verify requires claim_id');
            claim = verifyClaim(ctx.db, {
              claim_id: input.claim_id,
              confirm: input.confirm,
              ...(input.limitations !== undefined ? { limitations: input.limitations } : {}),
              // Re-reviewing a claim is the moment to set the next review date;
              // without this the verify branch dropped review_by and the boot
              // sweep re-expired the claim the caller had just re-verified.
              ...(input.review_by !== undefined ? { review_by: input.review_by } : {}),
              ...(input.clone_reference_ack !== undefined
                ? { clone_reference_ack: input.clone_reference_ack }
                : {}),
              reviewer: actor,
            });
            break;
          }
          case 'reject': {
            claim = rejectClaim(ctx.db, {
              claim_id: input.claim_id,
              reason: input.reason,
              confirm: input.confirm,
              reviewer: actor,
            });
            break;
          }
          case 'mark_ambiguous': {
            claim = markClaimAmbiguous(ctx.db, {
              claim_id: input.claim_id,
              confirm: input.confirm,
              reviewer: actor,
              ...(input.reason !== undefined ? { note: input.reason } : {}),
            });
            break;
          }
          case 'merge': {
            claim = mergeClaim(ctx.db, {
              claim_id: input.claim_id,
              merge_into: input.merge_into,
              confirm: input.confirm,
              reviewer: actor,
            });
            break;
          }
        }
        const { created } = detectConflicts(ctx.db);
        return { claim: publicClaim(claim), conflicts_created: created };
      },
    }),

    defineTool({
      name: 'linkedin_conflict_list',
      title: 'List claim conflicts',
      description: 'List detected evidence conflicts with their member claims.',
      inputSchema: z.object({
        state: z.enum(['open', 'resolved', 'dismissed']).optional(),
        type: z.enum(['contradiction', 'duplication', 'freshness', 'scope']).optional(),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            type: z.string(),
            state: z.string(),
            resolution_note: z.string().nullable(),
            created_at: z.string(),
            members: z.array(
              z.object({ claim_id: z.string(), statement: z.string(), state: z.string() }),
            ),
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
      handler: async ({ state, type, cursor, limit }) =>
        pageFromArray(
          listConflicts(ctx.db, {
            ...(state !== undefined ? { state } : {}),
            ...(type !== undefined ? { type } : {}),
          }),
          cursor,
          limit,
        ),
    }),

    defineTool({
      name: 'linkedin_conflict_resolve',
      title: 'Resolve a conflict',
      description:
        'Resolve or dismiss a conflict, optionally applying member claim transitions atomically (all-or-nothing). Human decision: requires confirm:true.',
      inputSchema: z.object({
        conflict_id: z.string(),
        resolution: z.enum(['resolved', 'dismissed']),
        note: z.string().min(3).max(1000),
        member_actions: z
          .array(
            z.object({
              claim_id: z.string(),
              action: z.enum(['verify', 'reject', 'mark_ambiguous']),
              reason: z.string().max(500).optional(),
            }),
          )
          .optional(),
        confirm: z.literal(true),
      }),
      outputSchema: z.object({
        conflict: z.object({
          id: z.string(),
          type: z.string(),
          state: z.string(),
          resolution_note: z.string().nullable(),
          members: z.array(
            z.object({ claim_id: z.string(), statement: z.string(), state: z.string() }),
          ),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        // A conflict resolution can permanently reject member claims.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ conflict_id, resolution, note, member_actions, confirm }) => {
        const conflict = resolveConflict(ctx.db, {
          conflict_id,
          resolution,
          note,
          ...(member_actions !== undefined ? { member_actions } : {}),
          confirm,
          reviewer: actor,
        });
        const { created_at, ...rest } = conflict;
        void created_at;
        return { conflict: rest };
      },
    }),

    defineTool({
      name: 'linkedin_coverage_check',
      title: 'Evidence coverage check',
      description:
        'Map each sentence of a text to supporting VERIFIED claims (deterministic token-overlap screening). Persists a content-addressed report; identical text returns the same report.',
      inputSchema: z.object({
        text: z.string().min(1).max(10_000),
      }),
      outputSchema: z.object({
        coverage_report_id: z.string(),
        supported_count: z.number(),
        total_count: z.number(),
        sentences: z.array(
          z.object({
            index: z.number(),
            text: z.string(),
            status: z.string(),
            claim_ids: z.array(z.string()),
            best_score: z.number(),
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
      handler: async ({ text }) => {
        const report = checkCoverage(ctx.db, { text });
        return {
          coverage_report_id: report.id,
          supported_count: report.supported_count,
          total_count: report.total_count,
          sentences: report.sentences,
        };
      },
    }),
  ];
}
