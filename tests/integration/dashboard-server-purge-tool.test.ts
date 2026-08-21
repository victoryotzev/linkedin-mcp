import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../linkedin-dashboard/src/auth.ts';
import { serverRequest } from '../helpers/clientHarness.ts';

// The same full purge, asked for through the MCP tool rather than the button.
//
// The dashboard's advanced console runs the real MCP registry, so
// linkedin_purge_run reaches the server's own shutdown hook — a different entry
// point to the same one-way door. It has to end in the same place: server
// closed, database closed, home gone. A tool path that deleted the data while
// the server still held the file would fail on Windows and leave a half-erased
// home, which is the worst possible outcome for an operation whose entire
// promise is that nothing survives it.
//
// The bind is stubbed. Everything else is the real thing.

interface Listener {
  event: string;
  handler: (...args: unknown[]) => void;
}

const listeners: Listener[] = [];
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
      close: (done?: () => void) => done?.(),
    };
  },
}));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-purge-tool-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
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

const runTool = async (name: string, input: unknown): Promise<Response> =>
  await app!.fetch(
    serverRequest(
      `/api/tools/${name}/run`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, input }),
      },
      await session(),
    ),
  );

describe('the advanced console over the running server', () => {
  it('refuses a tool name the registry does not have', async () => {
    const response = await runTool('linkedin_definitely_not_a_tool', {});

    // The console lists the real registry, so a name that is not in it means
    // the caller typed it — and answering with anything but "no such tool"
    // would suggest the operation ran.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toMatch(/is not available/i);
  });

  it('runs a read-only tool against the live database', async () => {
    const response = await runTool('linkedin_capability_status', {});

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toMatch(/linkedin\./);
  });
});

describe('a full purge requested through the MCP tool', () => {
  it('closes the server and the database, then deletes the home', async () => {
    expect(existsSync(join(home, 'data'))).toBe(true);
    const before = exits.length;

    const response = await runTool('linkedin_purge_run', {
      mode: 'purge_all',
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      accept_no_backup: true,
      confirm: true,
    });

    // The tool answers before the shutdown: it schedules the purge rather than
    // performing it, so the caller gets a reply instead of a dropped socket.
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toMatch(/purging/);

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(existsSync(join(home, 'data'))).toBe(false);
    expect(exits.length).toBeGreaterThan(before);
  }, 30_000);

  it('ignores a second request, because the first one is already running', async () => {
    const before = exits.length;

    // Scheduling twice would race two deletions of the same tree, and the
    // second would report a failure for work the first had already done.
    await runTool('linkedin_purge_run', {
      mode: 'purge_all',
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      accept_no_backup: true,
      confirm: true,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exits.length).toBe(before);
  }, 30_000);
});
