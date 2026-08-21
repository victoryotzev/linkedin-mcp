import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { ArtifactStore } from '@linkedin-mcp/db';
import {
  enableSourceFromDashboard,
  ingestBytes,
  readinessReport,
  registerVirtualSource,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const MIN_DESCRIPTION = 40;
const MAX_DESCRIPTION = 20_000;

/**
 * Self-description arrives through the model channel, which is exactly why it
 * is confirmed against the text rather than against an id.
 *
 * `ENABLE <source_id>` works for a filesystem source because the member is
 * approving a path they can read back. Here the payload is the thing being
 * approved, and an id-bound confirmation would let an agent collect the
 * member's yes and then store something else. Binding the command to a digest
 * of the exact text closes that, the same way a publication approval binds to a
 * revision hash instead of a draft id.
 */
function describeCommand(text: string): string {
  return `DESCRIBE ${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)}`;
}

export function onboardingTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);

  return [
    defineTool({
      name: 'linkedin_readiness_check',
      title: 'Check setup and what to do next',
      description:
        'Report what is configured, what needs attention, and the single most useful next step. Read-only: it never enables, imports, migrates, or verifies anything. Use this first on a new install, and whenever something appears not to work. A check reported as "unavailable" is not a task — it is something this member cannot act on, such as a LinkedIn credential outside the EEA or Switzerland.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        is_first_run: z.boolean(),
        next_step: z.string(),
        checks: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(['ok', 'action_needed', 'unavailable']),
            detail: z.string(),
            remediation: z.string().nullable(),
          }),
        ),
        counts: z.object({
          sources_enabled: z.number(),
          sources_pending: z.number(),
          artifacts: z.number(),
          claims_verified: z.number(),
          claims_awaiting_review: z.number(),
        }),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-read',
      handler: async () => readinessReport(ctx.db, { home: ctx.home }),
    }),

    defineTool({
      name: 'linkedin_intake_describe',
      title: 'Record what the member says about themselves',
      description:
        'Store a short self-description as evidence, for a member who has no CV to hand. The text is stored as a self-attested artifact: it ranks below a document the member wrote earlier, and claims resting only on it are self-reported rather than evidence-backed. Ask the member to write it in their own words, show them the exact text, and only then send it with the bound confirmation. Never compose this on their behalf and never send text they have not seen — the command is bound to a digest of the exact text for that reason. To preview the command without storing anything, call with confirm:false.',
      inputSchema: z.object({
        text: z.string().min(MIN_DESCRIPTION).max(MAX_DESCRIPTION),
        label: z.string().min(1).max(120).default('About me'),
        confirm: z.boolean().default(false),
        command: z
          .string()
          .optional()
          .describe('exactly: DESCRIBE <first 8 hex of the sha256 of text>'),
      }),
      outputSchema: z.object({
        stored: z.boolean(),
        expected_command: z.string(),
        source_id: z.string().nullable(),
        artifact_id: z.string().nullable(),
        trust: z.string(),
        char_count: z.number(),
        next_step: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async ({ text, label, confirm, command }) => {
        const expected = describeCommand(text);

        if (!confirm) {
          return {
            stored: false,
            expected_command: expected,
            source_id: null,
            artifact_id: null,
            trust: 'self_attested',
            char_count: text.length,
            next_step:
              'Show the member this exact text. If they confirm it is what they want recorded, send it again with confirm:true and the expected command.',
          };
        }
        if (command !== expected) {
          throw new DomainError(
            'INVALID_INPUT',
            `explicit confirmation required; command must be: ${expected}. A mismatch means the text changed after the member approved it.`,
            { blockers: ['confirmation_required'] },
          );
        }

        const source = registerVirtualSource(ctx.db, {
          origin: 'self_description',
          label,
          trust: 'self_attested',
          notes: 'Typed by the member during onboarding.',
        });
        // The bound confirmation above is the human decision, so recording it
        // as one keeps the audit trail honest about who chose this.
        enableSourceFromDashboard(ctx.db, source.id, actor);

        const store = new ArtifactStore(join(ctx.home, 'artifacts'));
        const report = await ingestBytes(ctx.db, store, {
          source_id: source.id,
          filename: 'about-me.md',
          bytes: Buffer.from(text, 'utf8'),
        });
        const artifactId = report.new_artifact_ids[0] ?? null;
        if (!artifactId) {
          throw new DomainError(
            'INTERNAL',
            `the description was not stored: ${report.rejects[0]?.reason ?? 'unknown reason'}`,
          );
        }

        return {
          stored: true,
          expected_command: expected,
          source_id: source.id,
          artifact_id: artifactId,
          trust: 'self_attested',
          char_count: text.length,
          next_step:
            'Propose narrow claims citing this artifact. Each still needs the member to verify it, and each stays self-reported until a document backs it.',
        };
      },
    }),
  ];
}
