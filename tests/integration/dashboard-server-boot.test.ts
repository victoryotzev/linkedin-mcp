import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// server.ts is the dashboard's entry point: it resolves the home, opens and
// migrates the database, seeds, sweeps, builds the app, and binds. All of that
// runs at import time, so nothing could reach it — importing the module in a
// test would have bound port 4780 and, on a missing client build, called
// process.exit.
//
// Stubbing the one call that binds is enough to run the whole boot sequence for
// real. Everything before `serve` is the part worth proving: a member whose
// first launch fails, fails here.

const listeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
let served: { hostname?: string; port?: number } | null = null;
let onListen: (() => void) | null = null;
const logs: string[] = [];
let home: string;

vi.mock('@hono/node-server', () => ({
  serve: (options: { hostname?: string; port?: number }, callback?: () => void) => {
    served = options;
    onListen = callback ?? null;
    // The shape server.ts uses: it registers an 'error' handler and calls
    // close() during shutdown.
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        listeners.push({ event, handler });
      },
      close: (done?: () => void) => done?.(),
    };
  },
}));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-boot-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // A real exit would end the test run; nothing in this boot should call it.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`unexpected process.exit(${code ?? 0}) during boot`);
  }) as never);

  await import('../../linkedin-dashboard/src/server.ts');
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // The booted server still holds the database open, and Windows will not
  // remove an open file. Leaving a temp directory behind is better than a
  // failing teardown that says nothing about the code.
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('boot sequence', () => {
  it('creates and migrates the database in the resolved home', () => {
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
  });

  it('binds loopback only', () => {
    // The bind address is the dashboard's transport boundary. Binding 0.0.0.0
    // would put a session-authenticated surface on the network.
    expect(served).not.toBeNull();
    expect(served?.hostname).toBe('127.0.0.1');
    expect(typeof served?.port).toBe('number');
  });

  it('prints a single-use launch URL carrying the token in the fragment', () => {
    onListen?.();
    const printed = logs.join('\n');

    // The fragment is what keeps the token out of server logs and proxies.
    expect(printed).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#t=/);
    expect(printed).toMatch(/single-launch|token/i);
    // The retention sweep result is reported rather than swallowed.
    expect(printed).toMatch(/retention sweep/i);
  });

  it('registers a listener for a port already in use', () => {
    // Two dashboards on one home is the case this exists for: the second must
    // say so rather than crash with a raw stack.
    expect(listeners.some((l) => l.event === 'error')).toBe(true);
  });
});

describe('the port-in-use path', () => {
  it('reports the existing window and exits cleanly, without falling through', () => {
    const errorHandler = listeners.find((l) => l.event === 'error')?.handler;
    expect(errorHandler).toBeTruthy();

    // The real process.exit never returns. A mock that does would let the
    // EADDRINUSE branch run and then fall straight into the generic one, so
    // the stub throws a sentinel to model the same control flow.
    class Exited extends Error {
      constructor(readonly code: number) {
        super('exit');
      }
    }
    const codes: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      codes.push(code ?? 0);
      throw new Exited(code ?? 0);
    }) as never);

    expect(() =>
      errorHandler?.(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })),
    ).toThrow(Exited);

    // Exactly one exit, and a zero: an already-running dashboard is the answer
    // to what the member was trying to do, not a failure.
    expect(codes).toEqual([0]);
  });

  it('exits non-zero for any other listen failure', () => {
    const errorHandler = listeners.find((l) => l.event === 'error')?.handler;
    const codes: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      codes.push(code ?? 0);
      throw new Error('exit');
    }) as never);

    expect(() =>
      errorHandler?.(Object.assign(new Error('listen EACCES'), { code: 'EACCES' })),
    ).toThrow();
    expect(codes).toEqual([1]);
  });
});
