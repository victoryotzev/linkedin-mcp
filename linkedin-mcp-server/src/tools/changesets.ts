import * as z from 'zod/v4';
import {
  CANONICAL_SECTIONS,
  exportChangeSet,
  generateChangeSet,
  getChangeSet,
  markPatchApplied,
  reviewPatch,
} from '@linkedin-mcp/domain';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const patchShape = z.object({
  id: z.string(),
  field_key: z.string(),
  old_text: z.string(),
  new_text: z.string(),
  char_limit: z.number().nullable(),
  char_count: z.number(),
  char_limit_ok: z.boolean(),
  claim_ids: z.array(z.string()),
  rationale: z.string().nullable(),
  risk_note: z.string().nullable(),
  kind: z.string(),
  state: z.string(),
  applied_at: z.string().nullable(),
  applied_verified_snapshot_id: z.string().nullable(),
  revision_hash: z.string(),
});

const changeSetShape = z.object({
  id: z.string(),
  title: z.string(),
  base_snapshot_id: z.string(),
  state: z.string(),
  created_at: z.string(),
  patches: z.array(patchShape),
});

export function changesetTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);
  return [
    defineTool({
      name: 'linkedin_changeset_generate',
      title: 'Generate field patches',
      description:
        'Generate exact old/new field patches from the canonical-vs-snapshot diff, evidence-linked. Cited claims are re-verified at generation time. Applying a patch is ALWAYS a manual copy/paste by the user — no profile-edit API exists.',
      inputSchema: z.object({
        title: z.string().min(3).max(120),
        base_snapshot_id: z.string().optional().describe('defaults to the latest snapshot'),
        sections: z.array(z.enum(CANONICAL_SECTIONS)).optional(),
        required_fields: z
          .array(z.string())
          .optional()
          .describe('field keys to label required_fix instead of optional_improvement'),
      }),
      outputSchema: z.object({ change_set: changeSetShape }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ title, base_snapshot_id, sections, required_fields }) => ({
        change_set: generateChangeSet(ctx.db, {
          title,
          ...(base_snapshot_id !== undefined ? { base_snapshot_id } : {}),
          ...(sections !== undefined ? { sections } : {}),
          ...(required_fields !== undefined ? { required_fields } : {}),
        }),
      }),
    }),

    defineTool({
      name: 'linkedin_changeset_review',
      title: 'Review a patch',
      description:
        'Accept, reject, edit, or supersede a field patch. Editing re-hashes the patch and drops it back to proposed — approvals never survive content changes. Get a change set by generating it or via the id returned earlier.',
      inputSchema: z.object({
        patch_id: z.string(),
        action: z.enum(['accept', 'reject', 'edit', 'supersede']),
        new_text: z.string().max(20_000).optional().describe('edit only'),
        note: z.string().max(500).optional(),
      }),
      outputSchema: z.object({ patch: patchShape }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ patch_id, action, new_text, note }) => ({
        patch: reviewPatch(ctx.db, {
          patch_id,
          action,
          ...(new_text !== undefined ? { new_text } : {}),
          ...(note !== undefined ? { note } : {}),
        }),
      }),
    }),

    defineTool({
      name: 'linkedin_changeset_export',
      title: 'Export copy-paste bundle',
      description:
        'Copy-paste bundle for all APPROVED patches in a change set: exact text (byte-identical to the approved patch), char counts vs limits, and where in the LinkedIn UI to paste each field. Blocks if any approved patch exceeds its char limit.',
      inputSchema: z.object({ change_set_id: z.string() }),
      outputSchema: z.object({
        change_set_id: z.string(),
        entries: z.array(
          z.object({
            patch_id: z.string(),
            field_key: z.string(),
            kind: z.string(),
            exact_text: z.string(),
            char_count: z.number(),
            char_limit: z.number().nullable(),
            ui_hint: z.string(),
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
      handler: async ({ change_set_id }) => exportChangeSet(ctx.db, change_set_id),
    }),

    defineTool({
      name: 'linkedin_patch_mark_applied',
      title: 'Mark patch applied',
      description:
        'Record that the user manually pasted an approved patch into LinkedIn. The next linkedin_snapshot_import auto-verifies it when the new text appears in the snapshot.',
      inputSchema: z.object({
        patch_id: z.string(),
        applied_at: z.string().optional(),
        confirm: z.literal(true),
      }),
      outputSchema: z.object({ patch: patchShape }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ patch_id, applied_at, confirm }) => ({
        patch: markPatchApplied(ctx.db, {
          patch_id,
          confirm,
          actor,
          ...(applied_at !== undefined ? { applied_at } : {}),
        }),
      }),
    }),

    defineTool({
      name: 'linkedin_changeset_get',
      title: 'Get a change set',
      description: 'Fetch a change set with all its patches and states.',
      inputSchema: z.object({ change_set_id: z.string() }),
      outputSchema: z.object({ change_set: changeSetShape }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async ({ change_set_id }) => ({ change_set: getChangeSet(ctx.db, change_set_id) }),
    }),
  ];
}
