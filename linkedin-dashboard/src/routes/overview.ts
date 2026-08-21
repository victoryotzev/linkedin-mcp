import { Hono } from 'hono';
import { workbenchSummary } from '@linkedin-mcp/domain';
import type { ApiDeps } from './types.ts';

// One call for the landing screen. Chain status is deliberately not part of it
// — see /system/chain.

export function overviewRoutes(deps: ApiDeps): Hono {
  const api = new Hono();
  api.get('/overview', (c) => c.json({ summary: workbenchSummary(deps.db) }));
  return api;
}
