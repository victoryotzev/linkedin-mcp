import * as z from 'zod/v4';
import { ALLOWED_SETTINGS, getSetting, setSetting } from '@linkedin-mcp/domain';
import type { Jsonish } from '@linkedin-mcp/shared';
import type { AppContext } from '../bootstrap.ts';
import { defineTool, type ToolDef } from '../registry.ts';

const fieldLimits = z
  .object({
    headline: z.number().int().min(1).max(100_000).optional(),
    about: z.number().int().min(1).max(100_000).optional(),
    experience: z.number().int().min(1).max(100_000).optional(),
    education: z.number().int().min(1).max(100_000).optional(),
    skills: z.number().int().min(1).max(100_000).optional(),
    post: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const piiBasename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[\\/\0]/.test(value),
    'must be a safe file basename',
  );

const settingInput = z.discriminatedUnion('key', [
  z.object({ key: z.literal('field_limits'), value: fieldLimits, confirm: z.literal(true) }),
  z.object({
    key: z.literal('dashboard.port'),
    value: z.number().int().min(1024).max(65535),
    confirm: z.literal(true),
  }),
  z.object({
    key: z.literal('importer.max_file_mb'),
    value: z.number().int().min(1).max(1024),
    confirm: z.literal(true),
  }),
  z.object({
    key: z.literal('importer.pii_skiplist'),
    value: z.array(piiBasename).max(100),
    confirm: z.literal(true),
  }),
  z.object({
    key: z.literal('linkedin.posts_api_version'),
    value: z.string().regex(/^20\d{2}(?:0[1-9]|1[0-2])$/),
    confirm: z.literal(true),
  }),
]);

const settingValue = z.union([fieldLimits, z.number().int(), z.array(z.string()), z.string()]);

export function settingsTools(ctx: AppContext): ToolDef[] {
  return [
    defineTool({
      name: 'linkedin_settings_set',
      title: 'Set a typed setting',
      description: `Set one confirmed, non-secret configuration value using its strict per-key schema. Allowed keys: ${Object.keys(ALLOWED_SETTINGS).join(', ')}. Credentials use the dashboard or masked human-control CLI.`,
      inputSchema: settingInput,
      outputSchema: z.object({
        key: z.string(),
        value: settingValue,
        updated_at: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'local-write',
      handler: async (input) => {
        setSetting(ctx.db, input.key, input.value as Jsonish, { confirm: input.confirm });
        return {
          key: input.key,
          value: getSetting(ctx.db, input.key) as z.output<typeof settingValue>,
          updated_at: new Date().toISOString(),
        };
      },
    }),
  ];
}
