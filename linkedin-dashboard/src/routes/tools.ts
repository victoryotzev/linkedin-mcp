import { Hono } from 'hono';
import { dashboardToolMetadata, invokeDashboardTool } from '@linkedin-mcp/server/dashboard';
import { DomainError } from '@linkedin-mcp/shared';
import { confirmedBody, type ApiDeps } from './types.ts';

// Advanced parity surface. Purpose-built dashboard screens remain the easiest
// path for common workflows; this route guarantees that every tool in the
// actual MCP registry is also usable from the authenticated human dashboard.
export function toolRoutes(deps: ApiDeps): Hono {
  const api = new Hono();

  api.get('/tools', (c) =>
    c.json({ tools: (deps.tools ?? []).map((tool) => dashboardToolMetadata(tool)) }),
  );

  api.post('/tools/:name/run', async (c) => {
    const body = await confirmedBody<{ input?: unknown }>(c);
    const tool = deps.tools?.find((candidate) => candidate.name === c.req.param('name'));
    if (!tool) {
      throw new DomainError('NOT_FOUND', `MCP tool ${c.req.param('name')} is not available`);
    }
    return c.json({ result: await invokeDashboardTool(tool, body.input ?? {}) });
  });

  return api;
}
