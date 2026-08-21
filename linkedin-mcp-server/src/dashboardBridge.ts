import * as z from 'zod/v4';
import { DomainError } from '@linkedin-mcp/shared';
import type { AppContext } from './bootstrap.ts';
import { toolDefs } from './catalog.ts';
import { sortTools, validateToolRegistry, type ToolDef } from './registry.ts';

export interface DashboardToolMetadata {
  name: string;
  title: string;
  description: string;
  permission: ToolDef['permission'];
  annotations: ToolDef['annotations'];
  input_schema: Record<string, unknown>;
}

/** The exact registry served to MCP clients, reused by the dashboard console. */
export function createDashboardToolCatalog(ctx: AppContext): ToolDef[] {
  const tools = sortTools(toolDefs(ctx));
  validateToolRegistry(tools);
  return tools;
}

export function dashboardToolMetadata(tool: ToolDef): DashboardToolMetadata {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    permission: tool.permission,
    annotations: tool.annotations,
    input_schema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  };
}

/**
 * Runs one registered tool through the same schemas used by the MCP SDK.
 * The dashboard never calls a handler with unvalidated JSON, and an invalid
 * handler result fails visibly instead of being rendered as trusted state.
 */
export async function invokeDashboardTool(tool: ToolDef, input: unknown): Promise<unknown> {
  const parsed = await tool.inputSchema.safeParseAsync(input);
  if (!parsed.success) {
    throw new DomainError('INVALID_INPUT', `invalid input for ${tool.name}`, {
      blockers: parsed.error.issues.slice(0, 10).map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      }),
    });
  }
  const result = await tool.handler(parsed.data as never);
  const validated = await tool.outputSchema.safeParseAsync(result);
  if (!validated.success) {
    throw new Error(`tool ${tool.name} returned data that does not match its output schema`);
  }
  return validated.data;
}

export type { ToolDef } from './registry.ts';
