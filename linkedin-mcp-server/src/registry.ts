import type * as z from 'zod/v4';

// SDK-neutral tool registry (plan PR2). Tools are declared against this shape
// only; exactly one adapter file binds the registry to the MCP SDK. If the SDK
// has to change (v2 -> v1 fallback, or a future v3), only the adapter moves.

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type PermissionTier = 'local-read' | 'local-write' | 'external-read' | 'external-write';

export interface ToolDef<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  name: `linkedin_${string}`;
  title: string;
  description: string;
  inputSchema: In;
  outputSchema: Out;
  // All four hints are required here on purpose: the spec's defaults are
  // pessimistic (destructive + open-world), so omission is never intended.
  annotations: ToolAnnotations;
  permission: PermissionTier;
  handler: (input: z.output<In>) => Promise<z.output<Out>>;
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  def: ToolDef<In, Out>,
): ToolDef<In, Out> {
  return def;
}

// Deterministic tools/list order (spec SHOULD: enables client caching).
export function sortTools(tools: readonly ToolDef[]): ToolDef[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

export function validateToolRegistry(tools: readonly ToolDef[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!/^linkedin_[a-z0-9_]+$/.test(tool.name)) {
      throw new Error(`invalid MCP tool name: ${tool.name}`);
    }
    if (seen.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`);
    seen.add(tool.name);
    if (tool.title.trim() === '' || tool.description.trim() === '') {
      throw new Error(`MCP tool ${tool.name} needs a title and description`);
    }
    const hints = Object.values(tool.annotations);
    if (hints.length !== 4 || hints.some((hint) => typeof hint !== 'boolean')) {
      throw new Error(`MCP tool ${tool.name} must declare all four boolean annotations`);
    }
    if (tool.annotations.readOnlyHint && tool.annotations.destructiveHint) {
      throw new Error(`MCP tool ${tool.name} cannot be both read-only and destructive`);
    }
  }
}
