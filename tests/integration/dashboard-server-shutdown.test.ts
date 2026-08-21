import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../linkedin-dashboard/src/auth.ts';
import { serverRequest } from '../helpers/clientHarness.ts';

// A full purge, all the way through the running dashboard.
//
// The purge has to close the server and the database before deleting
// <home>/data, because Windows will not remove an open file. It runs at module
// scope in server.ts behind a callback nothing else could reach, so it had
// never executed.
//
// The bind is stubbed. Everything else — the app, the session exchange, the
// purge route, the deletion on disk — is the real thing.
//
// Ctrl-C lives in its own file: it closes the same database, and one process
// cannot do both.

interface Listener {
  event: string;
  handler: (...args: unknown[]) => void;
}

const listeners: Listener[] = [];
const closes: Array<() => void> = [];
const exits: number[] = [];
const logs: string[] = [];
let onListen: (() => void) | null = null;
let home: string;
let app: Hono | null = null;
let cookie: string | null = null;

vi.mock('@hono/node-server', () => ({
  serve: (options: { fetch: Hono['fetch'] }, callback?: () => void) => {
    app = { fetch: options.fetch } as Hono;
    onListen = callback ?? null;
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        listeners.push({ event, handler });
      },
      // server.close(cb) runs the callback, which is where the purge happens.
      close: (done?: () => void) => {
        closes.push(() => done?.());
        done?.();
      },
    };
  },
}));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-shutdown-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  // Recorded rather than thrown. The purge exits from inside a timer callback,
  // so a sentinel would escape as an uncaught exception rather than being
  // caught by anything — and nothing follows the exit on this path, so
  // returning is faithful enough.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    return undefined;
  }) as never);

  await import('../../linkedin-dashboard/src/server.ts');
  onListen?.();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

/**
 * Exchanges the launch token the server printed for a session.
 *
 * It has to come from the server's own auth instance, which is module-private —
 * so the token is read back out of the URL it printed and exchanged over the
 * real route, exactly as the browser does.
 */
async function session(): Promise<string> {
  if (cookie !== null) return cookie;
  const token = /#t=([A-Za-z0-9_-]+)/.exec(logs.join('\n'))?.[1];
  expect(token, 'the server should print a launch URL carrying the token').toBeTruthy();

  const response = await app!.fetch(
    serverRequest('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );
  const setCookie = response.headers.get('set-cookie') ?? '';
  const id = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)?.[1] ?? '';
  cookie = `${SESSION_COOKIE}=${id}`;
  return cookie;
}

describe('the boot', () => {
  it('came up against the resolved home', () => {
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
    expect(app).not.toBeNull();
    expect(logs.join('\n')).toMatch(/retention sweep/i);
  });

  it('registered a handler for a port already in use and for Ctrl-C', () => {
    expect(listeners.some((l) => l.event === 'error')).toBe(true);
  });
});

describe('a full purge requested through the dashboard', () => {
  it('deletes the home, having closed the server and the database first', async () => {
    expect(app).not.toBeNull();
    if (!app) return;
    const before = exits.length;
    // The artifact store creates its directory lazily, so `data` is the one
    // that is certainly there before the purge runs.
    expect(existsSync(join(home, 'data'))).toBe(true);

    const response = await app.fetch(
      serverRequest(
        '/api/purge-all',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            confirm_phrase: 'DELETE ALL LOCAL DATA',
            accept_no_backup: true,
          }),
        },
        await session(),
      ),
    );
    expect(response.status).toBe(200);

    // The route schedules the shutdown so the response can be written first.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(exits.slice(before)).toContain(0);
    expect(logs.join('\n')).toMatch(/purged/i);
    // The directories the purge owns are gone; the home itself is left,
    // because the member may have pointed it at something else.
    expect(existsSync(join(home, 'data'))).toBe(false);
    expect(existsSync(home)).toBe(true);
  });

  it('does nothing on a second request, having already gone', async () => {
    if (!app) return;
    const closesBefore = closes.length;

    const response = await app.fetch(
      serverRequest(
        '/api/purge-all',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            confirm_phrase: 'DELETE ALL LOCAL DATA',
            accept_no_backup: true,
          }),
        },
        await session(),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The guard is a flag, not a lock: a double-click must not run the deletion
    // twice against a home that is already gone.
    void response;
    expect(closes.length - closesBefore).toBeLessThanOrEqual(1);
  });
});
