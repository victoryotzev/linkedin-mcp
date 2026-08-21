import type { Hono } from 'hono';
import { DashboardAuth, SESSION_COOKIE } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp, type DashboardDeps } from '../../linkedin-dashboard/src/app.ts';
import { createDashboardToolCatalog } from '../../linkedin-mcp-server/src/dashboardBridge.ts';
import { createFixture, type Fixture } from './fixtures.ts';

// Runs the browser client against the REAL API.
//
// This is the point of the DOM suites. The old node:vm test stubbed fetch with
// one hand-maintained union object for every request, so a renamed response
// field would have gone unnoticed forever and a wrong URL or verb was
// undetectable. Here every request the client makes is routed into
// buildDashboardApp over a seeded database.

const PORT = 4780;
export const HOST = `127.0.0.1:${PORT}`;

export interface ClientHarness {
  fixture: Fixture;
  app: Hono;
  cookie: string;
  /** Replaces globalThis.fetch. `intercept` can hijack a path, e.g. to hang it. */
  installApiFetch(intercept?: (path: string) => Response | Promise<Response> | null): void;
  close(): void;
}

/**
 * Builds a request as the SERVER would see it.
 *
 * `host` and `sec-fetch-site` are forbidden header names on the client side, so
 * happy-dom's Request drops them — correctly, since no page can set either. A
 * browser sets them on the wire and the server reads them, which is exactly
 * what the dashboard's guard depends on. This restores that view without
 * touching the guard, whose own behaviour is covered by the node-environment
 * route sweep.
 */
export function serverRequest(path: string, init: RequestInit = {}, cookie = ''): Request {
  const real = new Request(`http://${HOST}${path}`, init);
  const forbidden: Record<string, string> = {
    host: HOST,
    'sec-fetch-site': 'same-origin',
    ...(cookie ? { cookie } : {}),
  };
  const headers = {
    get: (name: string) => forbidden[name.toLowerCase()] ?? real.headers.get(name),
    has: (name: string) => forbidden[name.toLowerCase()] !== undefined || real.headers.has(name),
    forEach: real.headers.forEach.bind(real.headers),
    entries: real.headers.entries.bind(real.headers),
    [Symbol.iterator]: real.headers[Symbol.iterator].bind(real.headers),
  };
  return {
    method: real.method,
    url: real.url,
    headers,
    json: real.json.bind(real),
    text: real.text.bind(real),
    arrayBuffer: real.arrayBuffer.bind(real),
    // The intake upload is multipart, which is the only route that reads a
    // body any other way.
    formData: real.formData.bind(real),
    clone: () => serverRequest(path, init, cookie),
    body: real.body,
    bodyUsed: real.bodyUsed,
  } as unknown as Request;
}

/**
 * Collaborators the app takes as arguments.
 *
 * Left out by default so most suites exercise the fail-closed form of the
 * routes that need them, which is the honest default for a client test. A
 * suite that wants to drive a credential all the way through supplies them.
 */
export interface HarnessDeps {
  secretStore?: DashboardDeps['secretStore'];
  probeLane?: DashboardDeps['probeLane'];
  shutdown?: DashboardDeps['shutdown'];
}

export function createClientHarness(
  label: string,
  seed?: (fixture: Fixture) => void,
  deps: HarnessDeps = {},
): ClientHarness {
  const fixture = createFixture(label);
  seed?.(fixture);
  const auth = new DashboardAuth(PORT);
  const app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth,
    ...deps,
    // The advanced console renders the exact MCP registry. Without it that
    // screen renders an empty list, which is indistinguishable from a broken
    // one — and the client suites are the only place it is exercised.
    tools: createDashboardToolCatalog({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'dashboard',
    }),
  });

  // Exchanged through the auth object rather than by reading Set-Cookie off the
  // response: happy-dom's Headers hides that header, and the handshake itself
  // is covered thoroughly by the node-environment suites. What the DOM suites
  // test is the client.
  const sessionId = auth.exchangeToken(auth.launchToken);
  if (!sessionId) throw new Error('harness could not establish a session');
  const cookie = `${SESSION_COOKIE}=${sessionId}`;

  return {
    fixture,
    app,
    cookie,
    installApiFetch(intercept) {
      // Spelled out rather than using the DOM's RequestInfo: this helper is
      // typechecked by the node project, which deliberately has no DOM lib.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = typeof input === 'string' ? input : String(input);
        const custom = intercept?.(path);
        if (custom) return await custom;
        // FormData carries its own multipart content-type, complete with the
        // boundary; forcing application/json onto it makes the body unparseable.
        const isMultipart = typeof FormData !== 'undefined' && init?.body instanceof FormData;
        return await app.fetch(
          serverRequest(
            path,
            {
              method: init?.method ?? 'GET',
              ...(isMultipart ? {} : { headers: { 'content-type': 'application/json' } }),
              ...(init?.body ? { body: init.body } : {}),
            },
            cookie,
          ),
        );
      }) as typeof fetch;
    },
    close: () => fixture.close(),
  };
}

/** hono/jsx/dom schedules updates off the current task. */
export const flush = async (times = 6): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
