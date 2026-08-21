import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { createDashboardToolCatalog } from '../../linkedin-mcp-server/src/dashboardBridge.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Structural guards over the whole API surface.
//
// The dashboard went from 15 routes to roughly 35. Reviewing each one for
// "is it behind the guard", "does it mutate on a GET", "does it require
// confirmation" does not scale and does not survive the next contributor. These
// three tests enumerate the routes the app actually registered and check every
// one, so a mistake fails the suite rather than waiting to be noticed.

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

let fixture: Fixture;
let auth: DashboardAuth;
let app: Hono;
let seeded: ReturnType<typeof seedHealthy>;
/** The launch token is single-use by design, so the session is established once. */
let cookie: string;

beforeAll(async () => {
  fixture = createFixture('routes');
  seeded = seedHealthy(fixture);
  auth = new DashboardAuth(PORT);
  app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth,
    tools: createDashboardToolCatalog({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'dashboard',
    }),
  });
  cookie = await login();
});

afterAll(() => fixture.close());

function apiRoutes(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  return (
    app.routes
      .filter((route) => route.path.startsWith('/api/'))
      // The token exchange is the one route that cannot require a session: it is
      // how a session is obtained.
      .filter((route) => route.path !== '/api/session')
      .filter((route) => route.method === 'GET' || route.method === 'POST')
      .filter((route) => {
        const key = `${route.method} ${route.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((route) => ({ method: route.method, path: route.path }))
  );
}

/** Concrete values for :params, so routes resolve to real handlers. */
function concrete(path: string): string {
  return path
    .replace(':lane', 'read')
    .replace(':name', 'nonexistent-backup')
    .replace(':file', 'app-0000000000000000.js')
    .replace(':id', seeded.candidateId);
}

async function callRaw(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: HOST, 'sec-fetch-site': 'same-origin' };
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (method === 'POST') headers['content-type'] = 'application/json';
  return await app.fetch(
    new Request(`http://${HOST}${concrete(path)}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    }),
  );
}

async function login(): Promise<string> {
  const res = await app.fetch(
    new Request(`http://${HOST}/api/session`, {
      method: 'POST',
      headers: { host: HOST, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: auth.launchToken }),
    }),
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('every API route is behind the guard', () => {
  it('found a route table worth checking', () => {
    // A filter that silently matched nothing would make every test below
    // vacuous — the same failure mode the approval-authority grep guards
    // against by asserting a minimum file count.
    expect(apiRoutes().length).toBeGreaterThanOrEqual(25);
  });

  it('refuses every one of them without a session', async () => {
    const leaks: string[] = [];
    for (const route of apiRoutes()) {
      const res = await callRaw(route.method, route.path);
      if (res.status !== 401) leaks.push(`${route.method} ${route.path} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('refuses a foreign Host and a cross-site fetch on every one of them', async () => {
    const leaks: string[] = [];
    for (const route of apiRoutes()) {
      const target = `http://${HOST}${concrete(route.path)}`;
      const foreignHost = await app.fetch(
        new Request(target, {
          method: route.method,
          headers: { host: 'evil.example:4780', 'sec-fetch-site': 'same-origin', cookie },
          ...(route.method === 'POST' ? { body: '{}' } : {}),
        }),
      );
      const crossSite = await app.fetch(
        new Request(target, {
          method: route.method,
          headers: { host: HOST, 'sec-fetch-site': 'cross-site', cookie },
          ...(route.method === 'POST' ? { body: '{}' } : {}),
        }),
      );
      if (foreignHost.status !== 403) leaks.push(`host ${route.method} ${route.path}`);
      if (crossSite.status !== 403) leaks.push(`cross-site ${route.method} ${route.path}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('dashboard and MCP feature parity', () => {
  it('exposes the complete MCP registry through the authenticated dashboard', async () => {
    const response = await callRaw('GET', '/api/tools', { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string }> };
    expect(body.tools).toHaveLength(44);
    expect(new Set(body.tools.map((tool) => tool.name)).size).toBe(44);
  });

  it('runs the exact shared handler and attributes a review to the dashboard', async () => {
    const response = await callRaw('POST', '/api/tools/linkedin_claim_manage/run', {
      cookie,
      body: {
        confirm: true,
        input: { action: 'verify', claim_id: seeded.candidateId, confirm: true },
      },
    });
    expect(response.status).toBe(200);
    const reviewed = fixture.db.get(
      'SELECT state, reviewed_by FROM claims WHERE id = ?',
      seeded.candidateId,
    );
    expect(reviewed).toMatchObject({ state: 'verified', reviewed_by: 'dashboard' });
  });
});

describe('no GET writes', () => {
  function snapshot(): string {
    const tables = fixture.db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((row) => String(row['name']))
      .sort();
    return JSON.stringify(tables.map((table) => [table, fixture.db.all(`SELECT * FROM ${table}`)]));
  }

  it('leaves the database byte-identical after reading every GET route', async () => {
    const before = snapshot();

    for (const route of apiRoutes().filter((r) => r.method === 'GET')) {
      await callRaw('GET', route.path, { cookie });
    }

    // This is what forces coverage checking to be a POST behind an explicit
    // action: checkCoverage writes a content-addressed report row, so opening a
    // drawer that called it would mutate the database as a side effect of
    // navigation.
    expect(snapshot()).toBe(before);
  });
});

describe('every mutation is explicitly confirmed', () => {
  it('refuses each POST route that arrives without confirmation', async () => {
    const unguarded: string[] = [];
    for (const route of apiRoutes().filter((r) => r.method === 'POST')) {
      const res = await callRaw('POST', route.path, { cookie, body: {} });
      // 400 is the DomainError mapping. Anything that succeeded, or that
      // errored for an unrelated reason, is reported.
      if (res.status !== 400) unguarded.push(`${route.path} -> ${res.status}`);
    }
    expect(unguarded).toEqual([]);
  });
});
