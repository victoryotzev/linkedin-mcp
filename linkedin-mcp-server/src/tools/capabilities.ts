import * as z from 'zod/v4';
import {
  disablePublishing,
  enablePublishing,
  FEATURE_KEYS,
  getFeatureControl,
  listCapabilities,
  listFeatureControls,
  setFeatureControl,
} from '@linkedin-mcp/domain';
import type { AppContext } from '../bootstrap.ts';
import { contextActor } from '../bootstrap.ts';
import { defineTool, type ToolDef } from '../registry.ts';

export function capabilityTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);
  return [
    defineTool({
      name: 'linkedin_capability_status',
      title: 'Capability status',
      description:
        'List LinkedIn credential/API readiness with status, blockers, and remediation. This is separate from shared feature settings. Credentials use the dashboard or CLI; verification and non-secret feature decisions can also be performed through MCP with confirmation.',
      inputSchema: z.object({
        feature: z
          .string()
          .optional()
          .describe("Filter to a single feature key, e.g. 'linkedin.publish_post'"),
      }),
      outputSchema: z.object({
        capabilities: z.array(
          z.object({
            feature: z.string(),
            status: z.string(),
            blockers: z.array(z.string()),
            api_version: z.string().nullable(),
            verified_at: z.string().nullable(),
            notes: z.string().nullable(),
            remediation: z.string(),
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
      handler: async ({ feature }) => ({
        capabilities: listCapabilities(ctx.db, feature),
      }),
    }),
    defineTool({
      name: 'linkedin_feature_control',
      title: 'List or change shared feature settings',
      description:
        'List every MCP/dashboard feature group with its description and effective state, or enable/disable one after explicit confirmation. All groups default enabled except live_publishing. Secrets are not a feature setting and cannot be configured through MCP.',
      inputSchema: z.discriminatedUnion('action', [
        z.object({ action: z.literal('list') }),
        z.object({
          action: z.literal('set'),
          feature: z.enum(FEATURE_KEYS),
          enabled: z.boolean(),
          confirm: z.literal(true),
        }),
      ]),
      outputSchema: z.object({
        features: z.array(
          z.object({
            key: z.enum(FEATURE_KEYS),
            title: z.string(),
            description: z.string(),
            enabled: z.boolean(),
            default_enabled: z.boolean(),
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
        if (input.action === 'set') {
          const current = getFeatureControl(ctx.db, input.feature);
          if (current.enabled === input.enabled) return { features: listFeatureControls(ctx.db) };
          if (input.feature === 'live_publishing') {
            if (input.enabled) enablePublishing(ctx.db, true, actor);
            else disablePublishing(ctx.db, true, actor);
          }
          setFeatureControl(ctx.db, input.feature, input.enabled, {
            confirm: input.confirm,
            actor,
          });
        }
        return { features: listFeatureControls(ctx.db) };
      },
    }),
  ];
}
