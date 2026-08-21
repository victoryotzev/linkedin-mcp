import { afterEach, describe, expect, it } from 'vitest';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';

const fixtures: Fixture[] = [];
const HOST = '127.0.0.1:4780';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe('dashboard and MCP feature synchronization', () => {
  it('uses one persisted decision to block and restore both surfaces', async () => {
    const fixture = createFixture('feature-sync');
    fixtures.push(fixture);
    const auth = new DashboardAuth(4780);
    const app = buildDashboardApp({
      db: fixture.db,
      store: fixture.store,
      fts5: fixture.fts5,
      home: fixture.dir,
      auth,
    });
    const session = auth.exchangeToken(auth.launchToken)!;
    const request = (path: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(`http://${HOST}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            host: HOST,
            'sec-fetch-site': 'same-origin',
            cookie: `linkedin_mcp_session=${session}`,
            'content-type': 'application/json',
          },
          ...(init.body ? { body: init.body } : {}),
        }),
      );

    const disabled = await request('/api/features/analytics', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect((await request('/api/analytics')).status).toBe(400);

    const mcpAnalytics = toolDefs({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'mcp_host',
    }).find((tool) => tool.name === 'linkedin_analytics_query')!;
    await expect(mcpAnalytics.handler({ limit: 25 } as never)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      blockers: ['feature_disabled:analytics'],
    });

    const system = (await (await request('/api/system')).json()) as {
      features: Array<{ key: string; enabled: boolean }>;
    };
    expect(system.features.find((feature) => feature.key === 'analytics')?.enabled).toBe(false);
    expect(
      (
        await request('/api/features/analytics', {
          method: 'POST',
          body: JSON.stringify({ confirm: true, enabled: true }),
        })
      ).status,
    ).toBe(200);
    expect((await request('/api/analytics')).status).toBe(200);
  });
});
