import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { listBackups, listCapabilities, type SecretStore } from '@linkedin-mcp/domain';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { DashboardAuth, SESSION_COOKIE } from '../../linkedin-dashboard/src/auth.ts';
import { createDashboardToolCatalog } from '../../linkedin-mcp-server/src/dashboardBridge.ts';
import { serverRequest } from '../helpers/clientHarness.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The routes that only exist when the dashboard is fully wired.
//
// Storing a credential, proving it against LinkedIn and destroying everything
// all depend on collaborators the app takes as arguments — a secret store, a
// lane probe, a shutdown hook. Every other suite builds the app without them,
// which is correct for what those suites test and leaves these routes reachable
// only in their fail-closed form. This one supplies all three.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async put(name, value) {
      values.set(name, value);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    has(name) {
      return values.has(name);
    },
    listNames() {
      return [...values.keys()].sort();
    },
    async remove(name) {
      values.delete(name);
    },
  };
}

interface Wired {
  fixture: Fixture;
  app: Hono;
  cookie: string;
  secrets: ReturnType<typeof memorySecrets>;
  shutdowns: number[];
  probes: string[];
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
}

function wire(
  label: string,
  options: {
    probe?: (
      lane: string,
      token: string,
    ) => Promise<
      { ok: true; person_urn?: string } | { ok: false; status: number; message: string }
    >;
    withShutdown?: boolean;
  } = {},
): Wired {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  seedHealthy(fixture);
  const secrets = memorySecrets();
  const shutdowns: number[] = [];
  const probes: string[] = [];
  const auth = new DashboardAuth(4780);

  const app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth,
    secretStore: secrets,
    probeLane: async (lane, token) => {
      probes.push(`${lane}:${token.slice(0, 6)}`);
      return options.probe
        ? await options.probe(lane, token)
        : { ok: true as const, person_urn: 'urn:li:person:fixture' };
    },
    ...(options.withShutdown === false ? {} : { shutdown: () => shutdowns.push(1) }),
    tools: createDashboardToolCatalog({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'dashboard',
    }),
  });

  const sessionId = auth.exchangeToken(auth.launchToken);
  if (!sessionId) throw new Error('could not establish a session');
  const cookie = `${SESSION_COOKIE}=${sessionId}`;

  return {
    fixture,
    app,
    cookie,
    secrets,
    shutdowns,
    probes,
    get: async (path) => await app.fetch(serverRequest(path, { method: 'GET' }, cookie)),
    post: async (path, body) =>
      await app.fetch(
        serverRequest(
          path,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? { confirm: true }),
          },
          cookie,
        ),
      ),
  };
}

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

/** Lets the purge route's scheduled shutdown fire. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

describe('storing a credential through the dashboard', () => {
  it('encrypts it, and never reads it back in the response', async () => {
    const wired = wire('wired-token');

    const response = await wired.post('/api/lanes/read/token', {
      confirm: true,
      client_id: 'test-client-id-read',
      access_token: TOKEN,
    });
    const payload = await response.text();

    expect(response.status).toBe(200);
    // The one rule this route exists to keep: the token goes to the vault and
    // never comes back out through any read path, including this one.
    expect(payload).not.toContain(TOKEN);
    expect([...wired.secrets.values.values()]).toContain(TOKEN);
  });

  it('refuses a lane name it does not know', async () => {
    const wired = wire('wired-token-lane');

    const response = await wired.post('/api/lanes/sideways/token', {
      confirm: true,
      client_id: 'cid',
      access_token: TOKEN,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses without a confirmation', async () => {
    const wired = wire('wired-token-unconfirmed');

    const response = await wired.post('/api/lanes/read/token', {
      client_id: 'cid',
      access_token: TOKEN,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(wired.secrets.values.size).toBe(0);
  });

  it('accepts an optional expiry', async () => {
    const wired = wire('wired-token-expiry');

    const response = await wired.post('/api/lanes/write/token', {
      confirm: true,
      client_id: 'cid-write',
      access_token: TOKEN,
      expires_in_seconds: 900,
    });
    const body = (await response.json()) as { account: { token_expires_at: string | null } };

    expect(response.status).toBe(200);
    expect(body.account.token_expires_at).toBeTruthy();
  });
});

describe('verifying a lane through the dashboard', () => {
  it('probes with the stored token and reports the result', async () => {
    const wired = wire('wired-verify');
    await wired.post('/api/lanes/read/token', {
      confirm: true,
      client_id: 'cid-read',
      access_token: TOKEN,
    });

    const response = await wired.post('/api/lanes/read/verify', { confirm: true });
    const body = (await response.json()) as { result: { verified: string[] } };

    expect(response.status).toBe(200);
    // The probe received the real token, not a placeholder — that is what makes
    // verification mean anything.
    expect(wired.probes[0]).toBe('read:AQV-fa');
    expect(body.result.verified.length).toBeGreaterThan(0);
  });

  it('reports a failed probe and leaves the capability closed', async () => {
    const wired = wire('wired-verify-401', {
      probe: async () => ({ ok: false as const, status: 401, message: 'token expired' }),
    });
    await wired.post('/api/lanes/read/token', {
      confirm: true,
      client_id: 'cid-read',
      access_token: TOKEN,
    });

    const response = await wired.post('/api/lanes/read/verify', { confirm: true });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      listCapabilities(wired.fixture.db).every((c) => c.status !== 'verified' || c.blockers.length),
    ).toBe(true);
  });

  it('refuses to verify a lane name it does not know', async () => {
    const wired = wire('wired-verify-lane');
    const response = await wired.post('/api/lanes/sideways/verify', { confirm: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to verify a lane with no credential', async () => {
    const wired = wire('wired-verify-empty');
    const response = await wired.post('/api/lanes/read/verify', { confirm: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(wired.probes).toEqual([]);
  });
});

describe('turning publishing on through the dashboard', () => {
  it('refuses while the write lane has not been proved', async () => {
    const wired = wire('wired-publishing-unproven');

    const response = await wired.post('/api/capabilities/publishing/enable', { confirm: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('turns it on once the write lane is verified', async () => {
    const wired = wire('wired-publishing-ok');
    await wired.post('/api/lanes/write/token', {
      confirm: true,
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await wired.post('/api/lanes/write/verify', { confirm: true });

    const response = await wired.post('/api/capabilities/publishing/enable', { confirm: true });

    expect(response.status).toBe(200);
    expect(listCapabilities(wired.fixture.db, 'linkedin.publish_post')[0]?.status).toBe('verified');
  });
});

describe('feature toggles through the dashboard', () => {
  it('refuses a feature key it does not know', async () => {
    const wired = wire('wired-feature-unknown');
    const response = await wired.post('/api/features/not_a_feature', {
      confirm: true,
      enabled: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a request that does not say which way to set it', async () => {
    const wired = wire('wired-feature-noflag');
    const response = await wired.post('/api/features/live_publishing', { confirm: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('returns the current value unchanged when it is already in that state', async () => {
    const wired = wire('wired-feature-noop');

    const response = await wired.post('/api/features/live_publishing', {
      confirm: true,
      enabled: false,
    });
    const body = (await response.json()) as { feature: { enabled: boolean } };

    expect(response.status).toBe(200);
    expect(body.feature.enabled).toBe(false);
  });

  it('routes live_publishing through the same gate as the publishing route', async () => {
    const wired = wire('wired-feature-live');

    // A second door to the same room has to meet the same requirement.
    const response = await wired.post('/api/features/live_publishing', {
      confirm: true,
      enabled: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the full purge route', () => {
  it('refuses without the exact phrase', async () => {
    const wired = wire('wired-purge-phrase');

    const response = await wired.post('/api/purge-all', {
      confirm_phrase: 'delete all local data',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(wired.shutdowns).toEqual([]);
  });

  it('refuses when there is no verified backup and the loss is not accepted', async () => {
    const wired = wire('wired-purge-nobackup');

    const response = await wired.post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(wired.shutdowns).toEqual([]);
  });

  it('accepts once a backup has verified, and schedules the shutdown that deletes', async () => {
    const wired = wire('wired-purge-backup');
    const created = await wired.post('/api/backups', { confirm: true });
    expect(created.status).toBe(200);
    expect(listBackups(wired.fixture.dir).length).toBeGreaterThan(0);

    const response = await wired.post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
    });
    const body = (await response.json()) as { status: string; message: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe('purging');
    // The window is told it is looking at nothing, before it is true.
    expect(body.message).toMatch(/no longer connected/i);

    // The deletion is deliberately not inline: the response has to be written
    // and the database let go of before the files can be removed, so the hook
    // is scheduled rather than called.
    expect(wired.shutdowns).toEqual([]);
    expect(existsSync(join(wired.fixture.dir, 'artifacts'))).toBe(true);

    await settle();
    expect(wired.shutdowns).toEqual([1]);
  });

  it('accepts when the member accepts the loss instead of having a backup', async () => {
    const wired = wire('wired-purge-accepted');

    const response = await wired.post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      accept_no_backup: true,
    });

    expect(response.status).toBe(200);
    await settle();
    expect(wired.shutdowns).toEqual([1]);
  });

  it('refuses outright when the process has no way to shut down', async () => {
    const wired = wire('wired-purge-noshutdown', { withShutdown: false });

    // Deleting the files while the process holds the database open would leave
    // a half-destroyed home, so the route will not start what it cannot finish.
    const response = await wired.post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      accept_no_backup: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(existsSync(join(wired.fixture.dir, 'artifacts'))).toBe(true);
  });
});

describe('backups through the dashboard', () => {
  it('creates and verifies one, and refuses a name outside the managed root', async () => {
    const wired = wire('wired-backups');

    const created = await wired.post('/api/backups', { confirm: true });
    const body = (await created.json()) as { backup: { name: string } };
    expect(created.status).toBe(200);

    const verified = await wired.post(`/api/backups/${body.backup.name}/verify`, {
      confirm: true,
    });
    const verification = (await verified.json()) as { result: { valid: boolean } };
    expect(verification.result.valid).toBe(true);

    // A name is resolved by lookup, never used as a path.
    const escaped = await wired.post('/api/backups/..%2F..%2Fetc/verify', { confirm: true });
    expect(escaped.status).toBeGreaterThanOrEqual(400);
  });
});
