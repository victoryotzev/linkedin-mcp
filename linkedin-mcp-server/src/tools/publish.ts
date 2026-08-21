import * as z from 'zod/v4';
import {
  approvalPreview,
  createSecretStore,
  demoteLane,
  denyApproval,
  executePublication,
  getSettingOrDefault,
  getApproval,
  grantApproval,
  laneAccount,
  laneToken,
  listApprovals,
  listPublications,
  queryAuditEvents,
  reconcilePublication,
  resolveDashboardPort,
  requestApproval,
  requireFeatureEnabled,
  writeDraft,
  verifyAuditChain,
} from '@linkedin-mcp/domain';
import { DryRunPublisher, LinkedInRestPublisher, type Publisher } from '@linkedin-mcp/linkedin';
import { DomainError } from '@linkedin-mcp/shared';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, pageFromArray } from '../pagination.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
const dryRun = new DryRunPublisher();

interface AuditCursor {
  maxSeq: number;
  offset: number;
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAuditCursor(cursor: string | undefined): AuditCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<AuditCursor>;
    if (
      !Number.isSafeInteger(parsed.maxSeq) ||
      Number(parsed.maxSeq) < 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      Number(parsed.offset) < 0
    ) {
      throw new Error('invalid values');
    }
    return { maxSeq: Number(parsed.maxSeq), offset: Number(parsed.offset) };
  } catch {
    throw new DomainError('INVALID_INPUT', 'malformed audit pagination cursor');
  }
}

export function publishTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);
  const dashboardPort = resolveDashboardPort(ctx.db);
  const dashboardUrl = `http://127.0.0.1:${dashboardPort}/`;

  return [
    defineTool({
      name: 'linkedin_publish_request',
      title: 'Request publication approval',
      description:
        'Create a pending, revision-bound approval for a validated draft and return the exact preview a human must review. A later grant, rejection, or revision requires a separate explicit user confirmation through linkedin_approval_decide, the dashboard, or the human-control CLI.',
      inputSchema: z.object({
        draft_id: z.string(),
        intended_time: z.string().optional(),
        ttl_hours: z.number().int().min(1).max(720).optional(),
      }),
      outputSchema: z.object({
        approval_id: z.string(),
        state: z.string(),
        expires_at: z.string(),
        dashboard_url: z.string(),
        preview: z.object({
          draft_id: z.string(),
          revision_hash: z.string(),
          body_text: z.string(),
          visibility: z.string(),
          char_count: z.number(),
          media: z.array(z.object({ artifact_id: z.string(), alt: z.string() })),
          account_id: z.string(),
          intended_time: z.string().nullable(),
        }),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ draft_id, intended_time, ttl_hours }) => {
        const { approval, preview } = requestApproval(ctx.db, {
          draft_id,
          requested_by: actor,
          ...(intended_time !== undefined ? { intended_time } : {}),
          ...(ttl_hours !== undefined ? { ttl_hours } : {}),
        });
        return {
          approval_id: approval.id,
          state: approval.state,
          expires_at: approval.expires_at,
          dashboard_url: dashboardUrl,
          preview,
        };
      },
    }),

    defineTool({
      name: 'linkedin_approval_status',
      title: 'Approval status',
      description:
        'List approvals and their states, or inspect one with the exact text it binds. Approvals are single-use and die when the draft is edited.',
      inputSchema: z.object({
        approval_id: z.string().optional(),
        state: z
          .enum(['pending', 'granted', 'consumed', 'invalidated', 'expired', 'denied'])
          .optional(),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            draft_id: z.string(),
            state: z.string(),
            revision_hash: z.string(),
            account_id: z.string(),
            expires_at: z.string(),
            invalidated_by: z.string().nullable(),
          }),
        ),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
        preview: z
          .object({
            body_text: z.string(),
            visibility: z.string(),
            char_count: z.number(),
            revision_hash: z.string(),
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
      handler: async ({ approval_id, state, cursor, limit }) => {
        if (approval_id) {
          const approval = getApproval(ctx.db, approval_id);
          const preview = approvalPreview(ctx.db, approval_id);
          return {
            items: [
              {
                id: approval.id,
                draft_id: approval.draft_id,
                state: approval.state,
                revision_hash: approval.revision_hash,
                account_id: approval.account_id,
                expires_at: approval.expires_at,
                invalidated_by: approval.invalidated_by,
              },
            ],
            has_more: false,
            preview: {
              body_text: preview.body_text,
              visibility: preview.visibility,
              char_count: preview.char_count,
              revision_hash: preview.revision_hash,
            },
          };
        }
        const all = listApprovals(ctx.db, state).map((a) => ({
          id: a.id,
          draft_id: a.draft_id,
          state: a.state,
          revision_hash: a.revision_hash,
          account_id: a.account_id,
          expires_at: a.expires_at,
          invalidated_by: a.invalidated_by,
        }));
        return pageFromArray(all, cursor, limit);
      },
    }),

    defineTool({
      name: 'linkedin_approval_decide',
      title: 'Approve, reject, or revise a publication request',
      description:
        'Act on a pending publication request only after the user explicitly confirms the decision in the current conversation. Grant binds to the exact revision hash; deny requires a reason; revise appends new text and invalidates the pending approval. Ask for confirmation first and never infer approval from a general preference, old message, silence, or the fact that the agent drafted the text.',
      inputSchema: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('grant'),
          approval_id: z.string(),
          revision_hash: z.string().regex(/^[a-f0-9]{64}$/),
          command: z.string().describe('exactly: APPROVE <approval_id> <revision_hash>'),
          confirm: z.literal(true),
        }),
        z.object({
          action: z.literal('deny'),
          approval_id: z.string(),
          reason: z.string().min(3).max(500),
          command: z.string().describe('exactly: REJECT <approval_id>'),
          confirm: z.literal(true),
        }),
        z.object({
          action: z.literal('revise'),
          approval_id: z.string(),
          body_text: z.string().min(1).max(20_000),
          command: z.string().describe('exactly: REVISE <approval_id>'),
          confirm: z.literal(true),
        }),
      ]),
      outputSchema: z.object({
        action: z.enum(['grant', 'deny', 'revise']),
        approval_id: z.string(),
        approval_state: z.string(),
        draft_id: z.string(),
        revision_hash: z.string(),
        next_step: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        const approval = getApproval(ctx.db, input.approval_id);
        if (approval.state !== 'pending') {
          throw new DomainError(
            'TERMINAL_STATE',
            `approval ${approval.id} is ${approval.state}; only a pending request can be decided or revised`,
          );
        }
        const preview = approvalPreview(ctx.db, approval.id);
        if (input.action === 'grant') {
          if (input.revision_hash !== preview.revision_hash) {
            throw new DomainError(
              'APPROVAL_INVALIDATED',
              'the supplied revision hash does not match the exact approval preview; inspect it again',
              { blockers: ['revision_hash_mismatch'] },
            );
          }
          const expected = `APPROVE ${approval.id} ${preview.revision_hash}`;
          if (input.command !== expected) {
            throw new DomainError(
              'INVALID_INPUT',
              `explicit confirmation required; command must be: ${expected}`,
              {
                blockers: ['confirmation_required'],
              },
            );
          }
          const decided = grantApproval(ctx.db, approval.id, actor);
          return {
            action: input.action,
            approval_id: decided.id,
            approval_state: decided.state,
            draft_id: decided.draft_id,
            revision_hash: decided.revision_hash,
            next_step:
              'approval granted; publish only if the user also instructs publication execution',
          };
        }
        if (input.action === 'deny') {
          const expected = `REJECT ${approval.id}`;
          if (input.command !== expected) {
            throw new DomainError(
              'INVALID_INPUT',
              `explicit confirmation required; command must be: ${expected}`,
              {
                blockers: ['confirmation_required'],
              },
            );
          }
          const decided = denyApproval(ctx.db, approval.id, input.reason, actor);
          return {
            action: input.action,
            approval_id: decided.id,
            approval_state: decided.state,
            draft_id: decided.draft_id,
            revision_hash: decided.revision_hash,
            next_step: 'approval rejected; revise the draft before requesting another approval',
          };
        }

        const expected = `REVISE ${approval.id}`;
        if (input.command !== expected) {
          throw new DomainError(
            'INVALID_INPUT',
            `explicit confirmation required; command must be: ${expected}`,
            {
              blockers: ['confirmation_required'],
            },
          );
        }
        const revised = writeDraft(ctx.db, {
          draft_id: approval.draft_id,
          body_text: input.body_text,
          media: preview.media,
          visibility: preview.visibility as 'PUBLIC' | 'CONNECTIONS',
        });
        return {
          action: input.action,
          approval_id: approval.id,
          approval_state: getApproval(ctx.db, approval.id).state,
          draft_id: revised.draft.id,
          revision_hash: revised.revision.revision_hash,
          next_step:
            'draft revised and old approval invalidated; validate the new revision, then request fresh approval',
        };
      },
    }),

    defineTool({
      name: 'linkedin_publish_execute',
      title: 'Execute an approved publication',
      description:
        'Consume a GRANTED approval and publish through an adapter. Dry-run simulates the path. The real LinkedIn adapter requires live_publishing enabled, a verified write credential, and the exact PUBLISH command from the user. The approval is consumed before sending and is never reusable; a lost response is recorded as ambiguous and never auto-retried.',
      inputSchema: z.object({
        approval_id: z.string(),
        adapter: z.enum(['dry_run', 'linkedin']).default('dry_run'),
        account_id: z.string().optional(),
        command: z
          .string()
          .optional()
          .describe('for live publishing, exactly: PUBLISH <approval_id>'),
        confirm: z.boolean().optional(),
      }),
      outputSchema: z.object({
        publication_id: z.string(),
        outcome: z.string(),
        adapter: z.string(),
        linkedin_post_urn: z.string().nullable(),
        draft_id: z.string(),
        revision_hash: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      permission: 'external-write',
      handler: async ({ approval_id, adapter, account_id, command, confirm }) => {
        let publisher: Publisher = dryRun;
        let boundAccountId = account_id;
        if (adapter === 'linkedin') {
          const expected = `PUBLISH ${approval_id}`;
          if (confirm !== true || command !== expected) {
            throw new DomainError(
              'INVALID_INPUT',
              `live publishing requires explicit confirmation; command must be: ${expected}`,
              { blockers: ['confirmation_required'] },
            );
          }
          requireFeatureEnabled(ctx.db, 'live_publishing');
          const livePreview = approvalPreview(ctx.db, approval_id);
          if (livePreview.media.length > 0) {
            throw new DomainError(
              'CAPABILITY_UNAVAILABLE',
              'live media publishing is not available yet; remove media before requesting a new approval, or execute this approval as a dry run',
              { blockers: ['media_upload_not_implemented'] },
            );
          }
          const account = laneAccount(ctx.db, 'write');
          if (!account.person_urn) {
            throw new DomainError(
              'CAPABILITY_UNAVAILABLE',
              'the verified write lane has no person URN; verify it again before publishing',
              { blockers: ['person_urn_missing'] },
            );
          }
          if (account_id !== undefined && account_id !== account.id) {
            throw new DomainError(
              'ACCOUNT_MISMATCH',
              `the live publisher uses write-lane account ${account.id}, not ${account_id}`,
              { blockers: ['account_mismatch'] },
            );
          }
          const secrets = createSecretStore(ctx.db, ctx.home);
          const token = await laneToken(ctx.db, secrets, 'write');
          publisher = new LinkedInRestPublisher({
            accessToken: token,
            authorUrn: account.person_urn,
            postsApiVersion: getSettingOrDefault(ctx.db, 'linkedin.posts_api_version', '202605'),
            dmaApiVersion: '202312',
            onAuthorizationFailure: (status) =>
              demoteLane(
                ctx.db,
                'write',
                status === 401 ? 'expired' : 'revoked',
                status === 401 ? 'token_expired' : 'scope_missing',
              ),
          });
          boundAccountId = account.id;
        }
        const publication = await executePublication(ctx.db, publisher, {
          approval_id,
          actor,
          ...(boundAccountId !== undefined ? { account_id: boundAccountId } : {}),
        });
        return {
          publication_id: publication.id,
          outcome: publication.outcome,
          adapter: publication.adapter,
          linkedin_post_urn: publication.linkedin_post_urn,
          draft_id: publication.draft_id,
          revision_hash: publication.revision_hash,
        };
      },
    }),

    defineTool({
      name: 'linkedin_publication_reconcile',
      title: 'Reconcile an ambiguous publication',
      description:
        'Resolve a publication whose outcome is unknown because the response was lost. The user checks their LinkedIn activity and reports whether the post exists; a retry after "not found" requires a fresh approval.',
      inputSchema: z.object({
        publication_id: z.string(),
        found: z.boolean(),
        post_url: z.string().max(500).optional(),
        confirm: z.literal(true),
      }),
      outputSchema: z.object({
        publication_id: z.string(),
        outcome: z.string(),
        linkedin_post_urn: z.string().nullable(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ publication_id, found, post_url, confirm }) => {
        const publication = reconcilePublication(ctx.db, {
          publication_id,
          method: 'manual_attestation',
          found,
          confirm,
          actor,
          ...(post_url !== undefined ? { post_url } : {}),
        });
        return {
          publication_id: publication.id,
          outcome: publication.outcome,
          linkedin_post_urn: publication.linkedin_post_urn,
        };
      },
    }),

    defineTool({
      name: 'linkedin_audit_query',
      title: 'Query the audit log',
      description:
        'Read the append-only, hash-chained audit log and optionally verify the chain. A broken chain blocks all approvals and publications until the database is restored from a verified backup.',
      inputSchema: z.object({
        event_type: z.string().optional(),
        subject_id: z.string().optional(),
        since: z.string().optional(),
        verify_chain: z.boolean().default(false),
        cursor: z.string().optional(),
        limit: limitSchema,
      }),
      outputSchema: z.object({
        events: z.array(
          z.object({
            seq: z.number(),
            event_type: z.string(),
            actor: z.string(),
            subject_type: z.string(),
            subject_id: z.string().nullable(),
            payload: z.record(z.string(), z.unknown()),
            content_hash: z.string(),
            created_at: z.string(),
          }),
        ),
        has_more: z.boolean(),
        next_cursor: z.string().optional(),
        chain: z
          .object({
            valid: z.boolean(),
            length: z.number(),
            head_hash: z.string(),
            broken_at_seq: z.number().nullable(),
            reason: z.string().nullable(),
          })
          .optional(),
        publications: z.array(
          z.object({
            id: z.string(),
            draft_id: z.string(),
            outcome: z.string(),
            adapter: z.string(),
            linkedin_post_urn: z.string().nullable(),
            attempted_at: z.string(),
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
      handler: async ({ event_type, subject_id, since, verify_chain, cursor, limit }) => {
        const decoded = decodeAuditCursor(cursor);
        const maxSeq =
          decoded?.maxSeq ??
          // COALESCE cannot return null and an aggregate always returns a
          // row, so the fallback below is unreachable. It stays because
          // Number(undefined) is NaN, and NaN reaching a SQL OFFSET is worse
          // than a branch nothing exercises.
          Number(
            ctx.db.get('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM audit_events')?.['max_seq'] ??
              /* v8 ignore next */
              0,
          );
        const offset = decoded?.offset ?? 0;
        const rows = queryAuditEvents(ctx.db, {
          ...(event_type !== undefined ? { event_type } : {}),
          ...(subject_id !== undefined ? { subject_id } : {}),
          ...(since !== undefined ? { since } : {}),
          max_seq: maxSeq,
          limit: limit + 1,
          offset,
        });
        const events = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return {
          events,
          has_more: hasMore,
          ...(hasMore
            ? { next_cursor: encodeAuditCursor({ maxSeq, offset: offset + events.length }) }
            : {}),
          ...(verify_chain ? { chain: verifyAuditChain(ctx.db) } : {}),
          publications: listPublications(ctx.db)
            .slice(0, 20)
            .map((p) => ({
              id: p.id,
              draft_id: p.draft_id,
              outcome: p.outcome,
              adapter: p.adapter,
              linkedin_post_urn: p.linkedin_post_urn,
              attempted_at: p.attempted_at,
            })),
        };
      },
    }),
  ];
}
