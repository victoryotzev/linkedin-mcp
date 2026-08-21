import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp, CONTENT_SECURITY_POLICY } from '../../linkedin-dashboard/src/app.ts';
import {
  createAssetProvider,
  MissingClientBuildError,
  type AssetProvider,
} from '../../linkedin-dashboard/src/assets.ts';
import { BOOT_FALLBACK_HEADING } from '../../linkedin-dashboard/src/html.ts';

// The redesigned surface is the first thing in this codebase that can carry a
// strict CSP, because it is the first thing with no inline script or style.
// These tests pin that: the policy string exactly, the absence of inline code,
// and the guards on the asset routes. A widening edit fails here rather than
// quietly shipping.

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

let dir: string;
let assetDir: string;
let db: SqliteDriver;
let auth: DashboardAuth;
let app: ReturnType<typeof buildDashboardApp>;
let appWithoutAssets: ReturnType<typeof buildDashboardApp>;
let assets: AssetProvider;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-sec-'));
  // Synthetic assets: this suite is about routing and headers, not about the
  // real bundle's contents (that is dashboard-client-bundle).
  assetDir = join(dir, 'client');
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, 'app.js'), 'export const built = true;\n');
  writeFileSync(join(assetDir, 'app.css'), ':root{--x:1}\n');
  writeFileSync(join(assetDir, 'theme-boot.js'), 'globalThis.themed = true;\n');

  const opened = openDatabase(join(dir, 't.sqlite3'));
  db = opened.db;
  migrate(db);
  auth = new DashboardAuth(PORT);
  assets = createAssetProvider(assetDir);
  const deps = {
    db,
    store: new ArtifactStore(join(dir, 'artifacts')),
    fts5: opened.fts5,
    auth,
  };
  app = buildDashboardApp({ ...deps, assets });
  appWithoutAssets = buildDashboardApp(deps);
});

afterAll(() => {
  // Windows will not remove a directory holding an open SQLite file.
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function get(
  target: ReturnType<typeof buildDashboardApp>,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await target.fetch(
    new Request(`http://${HOST}${path}`, {
      headers: { host: HOST, 'sec-fetch-site': 'same-origin', ...headers },
    }),
  );
}

describe('redesigned surface: content security policy', () => {
  it('serves the shell with the exact policy, character for character', async () => {
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'; object-src 'none'",
    );
    // The exported constant and the literal above must agree, so neither can
    // drift without the other being noticed.
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('ships no inline script and no inline style, which is what makes that policy possible', async () => {
    const html = await (await get(app, '/')).text();
    // Every <script> must be a src reference with an empty body.
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, body] of scripts) {
      expect((body ?? '').trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son\w+=/);
  });

  it('references only same-origin hashed assets', async () => {
    const html = await (await get(app, '/')).text();
    expect(html).not.toMatch(/https?:\/\//);
    const manifest = assets.manifest();
    expect(html).toContain(manifest['app.js']);
    expect(html).toContain(manifest['app.css']);
    expect(html).toContain(manifest['theme-boot.js']);
    expect(manifest['app.js']).toMatch(/^\/assets\/app-[0-9a-f]{16}\.js$/);
  });

  it('renders a fallback panel that a dead client cannot hide', async () => {
    const html = await (await get(app, '/')).text();
    expect(html).toContain(BOOT_FALLBACK_HEADING);
    expect(html).toContain('npm run build -w @linkedin-mcp/dashboard');
    // The escape hatch back to the working dashboard.
    expect(html).toContain('href="/"');
  });

  it('loads the theme script synchronously, so a stored theme cannot flash', async () => {
    const html = await (await get(app, '/')).text();
    const themeTag = new RegExp(`<script src="${assets.manifest()['theme-boot.js']}"></script>`);
    expect(html).toMatch(themeTag);
    // A module script is deferred by definition, which would reintroduce the flash.
    expect(html).not.toMatch(/<script type="module" src="\/assets\/theme-boot/);
  });
});

describe('redesigned surface: asset routes', () => {
  it('serves hashed assets with immutable caching and the right type', async () => {
    const manifest = assets.manifest();
    const js = await get(app, manifest['app.js']);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const css = await get(app, manifest['app.css']);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('404s a stale hash rather than serving new bytes under an old immutable URL', async () => {
    const res = await get(app, '/assets/app-0000000000000000.js');
    expect(res.status).toBe(404);
  });

  it('applies the Host allowlist and the cross-site refusal to assets too', async () => {
    const manifest = assets.manifest();
    expect((await get(app, manifest['app.js'], { host: 'evil.example:4780' })).status).toBe(403);
    expect((await get(app, manifest['app.js'], { 'sec-fetch-site': 'cross-site' })).status).toBe(
      403,
    );
    expect((await get(app, '/', { host: 'evil.example:4780' })).status).toBe(403);
  });

  it('redirects the migration-era preview URL rather than 404ing it', async () => {
    const res = await get(app, '/preview');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('answers with the build command instead of a blank page when the client is unbuilt', async () => {
    const res = await get(appWithoutAssets, '/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build -w @linkedin-mcp/dashboard');
    expect((await get(appWithoutAssets, '/assets/app-0000000000000000.js')).status).toBe(404);
  });

  it('refuses to construct a provider over a missing build, naming the fix', () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(() => createAssetProvider(empty)).toThrow(MissingClientBuildError);
    expect(() => createAssetProvider(empty)).toThrow(/npm run build -w @linkedin-mcp\/dashboard/);
  });
});

describe('security headers', () => {
  it('sets the baseline headers on every response', async () => {
    const manifest = assets.manifest();
    for (const path of ['/', manifest['app.js'], '/api/sources']) {
      const res = await get(app, path);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
    }
  });

  it('now applies the policy to every response, not only to the shell', async () => {
    // The CSP used to be scoped to the new surface, because the previous page
    // was one inline <script> and one inline <style> and a strict policy would
    // have killed it. That page is gone, so nothing in this app emits inline
    // code and the policy covers everything — including the API and the
    // assets. That is a large part of what removing it bought.
    const manifest = assets.manifest();
    for (const path of ['/', '/preview', manifest['app.js'], manifest['app.css'], '/api/sources']) {
      const res = await get(app, path);
      expect(res.headers.get('content-security-policy'), `no policy on ${path}`).toBe(
        CONTENT_SECURITY_POLICY,
      );
    }
  });

  it('marks API responses uncacheable', async () => {
    const res = await app.fetch(
      new Request(`http://${HOST}/api/session`, {
        method: 'POST',
        headers: {
          host: HOST,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: auth.launchToken }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    // /api/session is registered on the root app, the rest on a sub-router.
    // Both must be covered — the first version of the middleware only caught
    // the sub-router, which left the Set-Cookie response cacheable.
    const guarded = await get(app, '/api/sources');
    expect(guarded.status).toBe(401);
    expect(guarded.headers.get('cache-control')).toBe('no-store');
  });
});
