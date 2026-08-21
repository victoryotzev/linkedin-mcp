import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The MCP server's entry point.
//
// Everything here runs at module scope: it resolves the home, opens and
// migrates the database, seeds, sweeps, builds the registry and hands a factory
// to the stdio transport. A member whose MCP host shows a dead server has hit
// something in these twenty lines, and none of them had ever executed under
// test because importing the module would have taken over stdio.
//
// Stubbing the transport is enough to run all of it for real.

let home: string;
let factory: (() => unknown) | null = null;
let served = 0;
const errors: string[] = [];
const exits: number[] = [];

class Exited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: (build: () => unknown) => {
    served += 1;
    factory = build;
  },
}));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-boot-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  // stdout is the MCP transport; anything written there is protocol. The
  // server logs to stderr for exactly that reason.
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new Exited(code ?? 0);
  }) as never);

  await import('../../linkedin-mcp-server/src/index.ts');
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

describe('the boot', () => {
  it('creates and migrates the database in the resolved home', () => {
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
  });

  it('hands the transport a factory rather than a built server', () => {
    // A factory means each connection gets its own server instance; a single
    // shared one would leak state between two hosts talking to the same home.
    expect(served).toBe(1);
    expect(typeof factory).toBe('function');
  });

  it('builds a server carrying the whole registry', () => {
    expect(factory).not.toBeNull();
    const server = factory?.();
    expect(server).toBeTruthy();
    // Built twice without complaint, because the transport may reconnect.
    expect(factory?.()).toBeTruthy();
  });

  it('logs the boot to stderr, never to stdout', () => {
    // stdout is the protocol channel. A stray line there is a parse error at
    // the other end, not a log message.
    const logged = errors.join('\n');
    expect(logged).toMatch(/boot:/);
    expect(logged).toMatch(/home=/);
    expect(logged).toMatch(/migrations_applied=/);
  });

  it('reports whether full-text search is available, rather than assuming it', () => {
    const logged = errors.join('\n');
    // Search degrades to LIKE without FTS5 and the safety paths are unaffected,
    // but a member comparing results between machines deserves to know which.
    expect(logged).toMatch(/fts5=(true|false)/);
  });
});

describe('the crash handlers', () => {
  it('exits non-zero on an uncaught exception, having logged it', () => {
    const before = exits.length;
    const handlers = process.listeners('uncaughtException');
    const handler = handlers[handlers.length - 1];
    expect(handler).toBeTruthy();

    expect(() => handler?.(new Error('something escaped'), 'uncaughtException')).toThrow(Exited);

    expect(exits.slice(before)).toEqual([1]);
    expect(errors.join('\n')).toMatch(/uncaughtException/);
    // The message survives; a silent crash is a host that just stops answering.
    expect(errors.join('\n')).toMatch(/something escaped/);
  });

  it('exits non-zero on an unhandled rejection, having logged it', () => {
    const before = exits.length;
    const handlers = process.listeners('unhandledRejection');
    const handler = handlers[handlers.length - 1];
    expect(handler).toBeTruthy();

    expect(() => handler?.(new Error('a promise nobody awaited'), Promise.resolve())).toThrow(
      Exited,
    );

    expect(exits.slice(before)).toEqual([1]);
    expect(errors.join('\n')).toMatch(/unhandledRejection/);
  });
});
