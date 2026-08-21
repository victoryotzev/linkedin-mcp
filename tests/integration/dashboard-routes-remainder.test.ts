import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureLane,
  getFeatureControl,
  listCapabilities,
  listCalendar,
  listPillars,
  listClaims,
  proposeClaim,
  runBackup,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { DashboardAuth, SESSION_COOKIE } from '../../linkedin-dashboard/src/auth.ts';
import { serverRequest } from '../helpers/clientHarness.ts';
import { createFixture, seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The dashboard routes a screen only reaches with a particular record in hand.
//
// Every one of these takes a value straight out of the URL or the body and
// hands it to the domain. The interesting half is what they do with the fields
// that were not sent: a partial update must not blank the parts of a record the
// member did not touch, and a reference that is not one must be refused before
// it reaches a resolver that reads by id.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;
let app: Hono;
let cookie: string;
let secrets: SecretStore;
let shutdowns = 0;

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
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

beforeEach(() => {
  fixture = createFixture('routes-remainder');
  seeded = seedHealthy(fixture);
  secrets = memorySecrets();
  shutdowns = 0;
  const auth = new DashboardAuth(4780);
  app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth,
    secretStore: secrets,
    shutdown: () => {
      shutdowns += 1;
    },
  });
  cookie = `${SESSION_COOKIE}=${auth.exchangeToken(auth.launchToken) ?? ''}`;
});

afterEach(() => fixture.close());

const get = (path: string) => app.fetch(serverRequest(path, {}, cookie));

const post = (path: string, body: unknown) =>
  app.fetch(
    serverRequest(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      cookie,
    ),
  );

describe('the profile diff', () => {
  it('refuses a reference that is not one of the three shapes', async () => {
    for (const right of ['latest', 'snapshot', '../etc', 'snapshot:../x', '']) {
      const response = await get(
        `/api/profile/diff?left=canonical&right=${encodeURIComponent(right)}`,
      );
      // The reference reaches a resolver that reads snapshots by id, so a typo
      // has to be refused at the edge rather than resolved to something.
      expect(response.status, right).toBeGreaterThanOrEqual(400);
    }
  });

  it('accepts the three shapes it does understand', async () => {
    const response = await get('/api/profile/diff?left=canonical&right=canonical');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { left: string; right: string };
    expect(body.left).toBe('canonical');
    expect(body.right).toBe('canonical');
  });

  it('refuses a snapshot reference with nothing behind it', async () => {
    // Defaulting to "no changes" when there is no snapshot would tell a member
    // their profile matches LinkedIn when nothing has ever been read from it.
    const response = await get('/api/profile/diff');

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('content pillars over the API', () => {
  it('creates one and then edits it by id without losing the rest', async () => {
    const created = (await (
      await post('/api/pillars', {
        confirm: true,
        name: 'Evidence tooling',
        description: 'Local-first systems.',
        audience: 'engineers',
      })
    ).json()) as { pillar: { id: string } };

    await post('/api/pillars', {
      confirm: true,
      id: created.pillar.id,
      name: 'Evidence tooling',
      description: 'Local-first systems, mostly on Windows.',
      audience: 'engineers who audit their own claims',
    });

    const pillars = listPillars(fixture.db);
    expect(pillars).toHaveLength(1);
    expect(pillars[0]?.description).toMatch(/mostly on Windows/);
  });

  it('refuses to change anything without a confirmation', async () => {
    const response = await post('/api/pillars', { name: 'No confirmation' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(listPillars(fixture.db)).toHaveLength(0);
  });
});

describe('the calendar over the API', () => {
  it('plans an entry with every field, then moves only its status', async () => {
    const created = (await (
      await post('/api/calendar', {
        confirm: true,
        intended_date: '2026-09-01',
        draft_id: seeded.draftId,
        pillar_id: null,
        status: 'planned',
        note: 'draw on the audit-chain claim',
      })
    ).json()) as { entry: { id: string } };

    await post('/api/calendar', { confirm: true, id: created.entry.id, status: 'drafted' });

    const entry = listCalendar(fixture.db).find((e) => e.id === created.entry.id);
    expect(entry?.status).toBe('drafted');
    // Nothing in this system fires from a date, so the note is the only record
    // of why the entry exists. An update that sent a status must not erase it.
    expect(entry?.note).toBe('draw on the audit-chain claim');
    expect(entry?.intended_date).toBe('2026-09-01');
  });
});

describe('verifying a claim over the API', () => {
  it('records the limitations the reviewer typed', async () => {
    const response = await post(`/api/claims/${seeded.candidateId}/verify`, {
      confirm: true,
      limitations: 'true of the CLI, not of the dashboard',
    });

    expect(response.status).toBe(200);
    const claim = listClaims(fixture.db, {}, false).find((c) => c.id === seeded.candidateId);
    // The wording travels into every patch and draft that cites this claim, so
    // dropping it here would silently widen what the member is claiming.
    expect(claim?.limitations).toBe('true of the CLI, not of the dashboard');
    expect(claim?.state).toBe('verified');
  });
});

describe('verifying a clone-backed claim over the API', () => {
  it('carries the acknowledgement through, because familiarity is not authorship', async () => {
    const { artifactId } = seedRealArtifact(
      fixture,
      'The upstream project implements a deterministic CSV parser.',
      { trust: 'local_clone_reference', relpath: 'vendor/README.md' },
    );
    const claim = proposeClaim(fixture.db, {
      statement: 'The upstream deterministic CSV parser is well understood here.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });

    const refused = await post(`/api/claims/${claim.id}/verify`, { confirm: true });
    // Fail-closed: no word list can be trusted to catch every phrasing, so
    // clone-backed evidence is refused until the reviewer states the intent.
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const accepted = await post(`/api/claims/${claim.id}/verify`, {
      confirm: true,
      clone_reference_ack: true,
      limitations: 'familiarity only; not authored by me',
    });

    expect(accepted.status).toBe(200);
    const verified = listClaims(fixture.db, {}, false).find((c) => c.id === claim.id);
    expect(verified?.state).toBe('verified');
    expect(verified?.limitations).toMatch(/familiarity only/i);
  });
});

describe('the publishing switch over the API', () => {
  async function proveWriteLane(): Promise<void> {
    await configureLane(fixture.db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await verifyLane(
      fixture.db,
      secrets,
      'write',
      async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );
  }

  it('opens and closes the capability, not just the setting', async () => {
    await proveWriteLane();

    await post('/api/features/live_publishing', { confirm: true, enabled: true });
    expect(listCapabilities(fixture.db, 'linkedin.publish_post')[0]?.status).toBe('verified');

    await post('/api/features/live_publishing', { confirm: true, enabled: false });

    expect(getFeatureControl(fixture.db, 'live_publishing').enabled).toBe(false);
    expect(listCapabilities(fixture.db, 'linkedin.publish_post')[0]?.status).not.toBe('verified');
  });

  it('changes nothing when the switch is already where it is asked to be', async () => {
    const response = await post('/api/features/analytics', { confirm: true, enabled: true });

    expect(response.status).toBe(200);
    expect(getFeatureControl(fixture.db, 'analytics').enabled).toBe(true);
  });

  it('refuses a feature key it does not have', async () => {
    const response = await post('/api/features/delete_everything', {
      confirm: true,
      enabled: true,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the full purge over the API', () => {
  it('refuses when there is no backup at all', async () => {
    const response = await post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toMatch(/backup/i);
  });

  it('does not count a folder someone dropped into the backups directory', async () => {
    const stray = join(fixture.dir, 'backups', 'dropped in by hand');
    mkdirSync(stray, { recursive: true });
    writeFileSync(
      join(stray, 'backup-manifest.json'),
      JSON.stringify({ format_version: 1, created_at: '', entries: [] }),
      'utf8',
    );

    const response = await post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
    });

    // It lists, because hiding it would leave a member believing they have one
    // fewer backup than they do. It cannot be verified, so it never unlocks an
    // irreversible delete.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toMatch(/backup/i);
    expect(shutdowns).toBe(0);
  });

  it('accepts once a real backup verifies', async () => {
    await runBackup(fixture.db, fixture.dir, { actor: 'dashboard' });

    const response = await post('/api/purge-all', {
      confirm_phrase: 'DELETE ALL LOCAL DATA',
    });

    // The route schedules the shutdown rather than performing it, so the
    // caller gets a reply instead of a dropped socket.
    expect(response.status).toBeLessThan(400);
    // Scheduled after the reply is written, so the caller gets an answer
    // instead of a dropped socket.
    expect(shutdowns).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(shutdowns).toBe(1);
  }, 60_000);

  it('refuses the wrong phrase even with a verified backup', async () => {
    await runBackup(fixture.db, fixture.dir, { actor: 'dashboard' });

    const response = await post('/api/purge-all', { confirm_phrase: 'delete all local data' });

    // Typed exactly, in capitals: the phrase is the last thing between a member
    // and an irreversible delete, so a near miss is a miss.
    expect(response.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});

describe('the artifact store behind the routes', () => {
  it('serves an artifact detail with its preview', async () => {
    const response = await get(`/api/artifacts/${seeded.artifactId}`);

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(seeded.artifactId);
  });

  it('reports a home the store has never written to', () => {
    // Nothing is created until the first import, so a fresh home has no
    // artifacts directory at all.
    expect(fixture.store.pathFor('a'.repeat(64))).toContain(join('artifacts', 'sha256'));
  });
});
