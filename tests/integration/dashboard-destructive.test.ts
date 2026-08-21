import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretStorePort } from '@linkedin-mcp/domain';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { performFullPurge } from '../../linkedin-dashboard/src/routes/system.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The irreversible paths, and the credential that must never come back out.

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = 'AQV-fixture-access-token-value-000000000';

let fixture: Fixture;
let app: Hono;
let auth: DashboardAuth;
let cookie: string;

/** In-memory stand-in: the real store is DPAPI-backed and Windows-only. */
function fakeSecretStore(): SecretStorePort {
  const values = new Map<string, string>();
  return {
    put: async (name, value) => void values.set(name, value),
    get: async (name) => values.get(name) ?? null,
    has: (name) => values.has(name),
    remove: async (name) => void values.delete(name),
  };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.fetch(
    new Request(`http://${HOST}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        host: HOST,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie,
        ...((init.headers as Record<string, string>) ?? {}),
      },
      ...(init.body ? { body: init.body } : {}),
    }),
  );
}

beforeEach(async () => {
  fixture = createFixture('destructive');
  seedHealthy(fixture);
  auth = new DashboardAuth(PORT);
  app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth,
    secretStore: fakeSecretStore(),
  });
  const res = await call('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: auth.launchToken }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});

afterEach(() => fixture.close());

describe('a stored credential never comes back out', () => {
  it('is absent from every readable response', async () => {
    const stored = await call('/api/lanes/read/token', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        client_id: 'fixture-client',
        access_token: TOKEN,
      }),
    });
    expect(stored.status).toBe(200);
    // Even the response that stored it must not echo it.
    expect(await stored.text()).not.toContain(TOKEN);

    const readable = [
      '/api/overview',
      '/api/system',
      '/api/system/chain',
      '/api/audit',
      '/api/sources',
      '/api/claims',
      '/api/artifacts',
      '/api/profile',
      '/api/changesets',
      '/api/drafts',
      '/api/approvals',
      '/api/publications',
      '/api/analytics',
      '/api/export-bundle',
      '/api/backups',
    ];
    for (const path of readable) {
      const body = await (await call(path)).text();
      expect(body, `${path} leaked the stored token`).not.toContain(TOKEN);
    }
  });

  it('records the configuration in the audit log without the value', async () => {
    await call('/api/lanes/read/token', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, client_id: 'fixture-client', access_token: TOKEN }),
    });
    const audit = await (await call('/api/audit?limit=50')).text();
    expect(audit).toContain('capability.token_configured');
    expect(audit).not.toContain(TOKEN);
  });
});

describe('artifact purge', () => {
  it('refuses while a live claim cites the artifact, and names the claims', async () => {
    const artifact = fixture.db.get('SELECT id FROM artifacts LIMIT 1');
    const res = await call(`/api/artifacts/${String(artifact?.['id'])}/purge`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('cited by');
    // Still there. A refused purge must not have deleted anything.
    expect(
      fixture.db.get('SELECT id FROM artifacts WHERE id = ?', String(artifact?.['id'])),
    ).toBeDefined();
  });
});

describe('full local purge', () => {
  it('refuses without the exact phrase', async () => {
    for (const phrase of [undefined, '', 'delete all local data', 'DELETE ALL DATA']) {
      const res = await call('/api/purge-all', {
        method: 'POST',
        body: JSON.stringify(phrase === undefined ? {} : { confirm_phrase: phrase }),
      });
      expect(res.status, `phrase ${JSON.stringify(phrase)} must be refused`).toBe(400);
    }
    // Nothing was touched.
    expect(existsSync(join(fixture.dir, 't.sqlite3'))).toBe(true);
  });

  it('refuses when no shutdown hook is available rather than half-deleting', async () => {
    // buildDashboardApp above has no `shutdown`, so the route cannot sequence
    // the close-then-delete correctly and must not start.
    const res = await call('/api/purge-all', {
      method: 'POST',
      body: JSON.stringify({ confirm_phrase: 'DELETE ALL LOCAL DATA' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('shutdown hook');
  });

  it('closes the database before deleting, so Windows cannot block the removal', () => {
    // The ordering is the whole point: purgeEverything removes <home>/data
    // while the process holds the SQLite file open, and Windows refuses to
    // delete an open file. Reported partial failure is better than a claimed
    // success over a half-deleted home.
    const local = createFixture('purge');
    for (const dir of ['artifacts', 'backups', 'logs', 'secrets']) {
      mkdirSync(join(local.dir, dir), { recursive: true });
      writeFileSync(join(local.dir, dir, 'placeholder'), 'x');
    }
    mkdirSync(join(local.dir, 'data'), { recursive: true });
    writeFileSync(join(local.dir, 'data', 'linkedin.sqlite3'), 'x');

    let closed = false;
    const result = performFullPurge(local.dir, () => {
      closed = true;
      local.db.close();
    });

    expect(closed).toBe(true);
    expect(result.removed.sort()).toEqual(['artifacts', 'backups', 'data', 'logs', 'secrets']);
    for (const dir of result.removed) {
      expect(existsSync(join(local.dir, dir)), `${dir} must be gone`).toBe(false);
    }
  });
});
