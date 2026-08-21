import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { getSource, listClaims, proposeClaim } from '@linkedin-mcp/domain';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { seedSourceAndArtifact } from '../helpers/seed.ts';
import type { Hono } from 'hono';

const PORT = 4780;
const GOOD_HOST = `127.0.0.1:${PORT}`;

let dir: string;
let db: SqliteDriver;
let app: Hono;
let auth: DashboardAuth;
let artifactId: string;
let pendingSourceId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-dash-'));
  const opened = openDatabase(join(dir, 't.sqlite3'));
  db = opened.db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
  pendingSourceId = seedPendingSource();
  auth = new DashboardAuth(PORT);
  app = buildDashboardApp({
    db,
    store: new ArtifactStore(join(dir, 'artifacts')),
    fts5: opened.fts5,
    auth,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function seedPendingSource(): string {
  const id = `src_${'0'.repeat(22)}PEND`;
  db.run(
    `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
     VALUES (?, 'folder', 'C:\\fixture\\pending', 'pending fixture', 'personal_doc', 'pending_review', ?)`,
    id,
    new Date().toISOString(),
  );
  return id;
}

interface CallOpts {
  method?: string;
  body?: unknown;
  host?: string;
  secFetchSite?: string | null;
  cookie?: string;
}

async function call(path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = { host: opts.host ?? GOOD_HOST };
  if (opts.secFetchSite !== null) headers['sec-fetch-site'] = opts.secFetchSite ?? 'same-origin';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.fetch(
    new Request(`http://${headers['host']}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
}

async function login(): Promise<string> {
  const res = await call('/api/session', { body: { token: auth.launchToken } });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie')!;
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  return setCookie.split(';')[0]!;
}

describe('dashboard-lite guards', () => {
  // The launch token is printed to a terminal and rides in a URL fragment, so
  // it outlives the moment it was needed — in scrollback, in a copied link, in
  // a screen share. It was documented as "exchanged once" but was in fact
  // reusable for the life of the process, so anyone replaying it got a fresh
  // session.
  it('spends the launch token on first exchange', async () => {
    const first = await call('/api/session', { body: { token: auth.launchToken } });
    expect(first.status).toBe(200);

    const replay = await call('/api/session', { body: { token: auth.launchToken } });
    expect(replay.status).not.toBe(200);

    // The session minted by the first exchange still works.
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call('/api/sources', { cookie })).status).toBe(200);
  });

  it('refuses foreign Host headers (DNS rebinding defense)', async () => {
    const res = await call('/api/sources', { host: 'evil.example:4780' });
    expect(res.status).toBe(403);
  });

  it('refuses cross-site and missing Sec-Fetch-Site', async () => {
    const cookie = await login();
    expect((await call('/api/sources', { cookie, secFetchSite: 'cross-site' })).status).toBe(403);
    expect((await call('/api/sources', { cookie, secFetchSite: null })).status).toBe(403);
  });

  it('refuses unauthenticated API access and bad tokens', async () => {
    expect((await call('/api/sources')).status).toBe(401);
    expect((await call('/api/session', { body: { token: 'wrong-token' } })).status).toBe(403);
  });
});

describe('dashboard-lite flows', () => {
  it('enables a pending source — the only enable path in the system', async () => {
    const cookie = await login();
    const res = await call(`/api/sources/${pendingSourceId}/enable`, {
      cookie,
      body: { confirm: true },
    });
    expect(res.status).toBe(200);
    expect(getSource(db, pendingSourceId).status).toBe('enabled');
  });

  it('refuses a state change that was not explicitly confirmed', async () => {
    // Every mutating route requires confirm: true. The session cookie is
    // already SameSite=Strict and the guard already demands same-origin, so
    // this is belt and braces — but it means no state change can be provoked by
    // a bare request that merely arrives at the right URL.
    const cookie = await login();
    const res = await call(`/api/sources/${pendingSourceId}/enable`, { cookie, body: {} });
    expect(res.status).toBe(400);
    expect(getSource(db, pendingSourceId).status).toBe('pending_review');
  });

  it('verifies and rejects claims through the review endpoints', async () => {
    const cookie = await login();
    const a = proposeClaim(db, {
      statement: 'Dashboard-reviewed statement number one.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    const b = proposeClaim(db, {
      statement: 'Dashboard-reviewed statement number two.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });

    const verifyRes = await call(`/api/claims/${a.id}/verify`, {
      cookie,
      body: { confirm: true, limitations: 'coursework only' },
    });
    expect(verifyRes.status).toBe(200);

    const rejectRes = await call(`/api/claims/${b.id}/reject`, {
      cookie,
      body: { confirm: true, reason: 'not supported by the cited file' },
    });
    expect(rejectRes.status).toBe(200);

    expect(listClaims(db, { state: 'verified' }, false)).toHaveLength(1);
    expect(listClaims(db, { state: 'rejected' }, false)).toHaveLength(1);

    // Rejection without a reason fails closed (tombstones need reasons).
    const c = proposeClaim(db, {
      statement: 'Dashboard-reviewed statement number three.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    expect(
      (await call(`/api/claims/${c.id}/reject`, { cookie, body: { confirm: true } })).status,
    ).toBe(400);
  });
});
