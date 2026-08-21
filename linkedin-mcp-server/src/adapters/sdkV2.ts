import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DomainError } from '@linkedin-mcp/shared';
import { logError } from '../log.ts';
import { sortTools, validateToolRegistry, type ToolDef } from '../registry.ts';
import type { ResourceDef } from '../resources.ts';
import type { PromptDef } from '../prompts.ts';

// The single point where the SDK-neutral registry meets the MCP SDK (v2).
// Conventions enforced here, once, for every tool:
//   - structuredContent + serialized-JSON TextContent echo (spec SHOULD)
//   - DomainError -> in-result error payload with isError: true
//   - unexpected errors -> INTERNAL payload, details only to stderr
export function buildServer(
  tools: readonly ToolDef[],
  resources: readonly ResourceDef[] = [],
  prompts: readonly PromptDef[] = [],
): McpServer {
  validateToolRegistry(tools);
  const server = new McpServer({ name: 'linkedin-mcp', version: '0.1.0' });

  for (const tool of sortTools(tools)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown) => {
        try {
          const output = await tool.handler(input as never);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (err) {
          const payload =
            err instanceof DomainError
              ? { error: err.toResultPayload() }
              : {
                  error: {
                    code: 'INTERNAL',
                    message: 'unexpected server error; details logged to stderr',
                    blockers: [],
                    retryable: false,
                  },
                };
          if (!(err instanceof DomainError)) {
            logError(`tool ${tool.name} failed`, err);
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: true,
          };
        }
      },
    );
  }

  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri: URL) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: resource.mimeType,
            text: resource.read().text,
          },
        ],
        // Cacheability travels with the result: everything here is personal,
        // so the scope is private and TTLs stay short for mutable data.
        ttlMs: resource.ttlMs,
        cacheScope: resource.cacheScope,
      }),
    );
  }

  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: Object.fromEntries(
          prompt.arguments.map((arg) => [
            arg.name,
            arg.required
              ? z.string().describe(arg.description)
              : z.string().optional().describe(arg.description),
          ]),
        ),
      },
      (args: Record<string, string | undefined>) => ({
        messages: [
          { role: 'user' as const, content: { type: 'text' as const, text: prompt.build(args) } },
        ],
      }),
    );
  }

  return server;
}
