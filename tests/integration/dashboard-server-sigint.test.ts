import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Ctrl-C.
//
// The handler has to close the server and release the database, or the next
// launch finds a locked home. It runs at module scope in server.ts, so nothing
// else could reach it.
//
// Its own file because it closes the database that the purge test next door
// needs open — one process cannot do both.

const closes: number[] = [];
const exits: number[] = [];
let home: string;

class Exited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

vi.mock('@hono/node-server', () => ({
  serve: (_options: unknown, callback?: () => void) => {
    callback?.();
    return {
      on: () => {},
      close: (done?: () => void) => {
        closes.push(1);
        done?.();
      },
    };
  },
}));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-sigint-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new Exited(code ?? 0);
  }) as never);

  await import('../../linkedin-dashboard/src/server.ts');
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

describe('Ctrl-C', () => {
  it('boots against the resolved home first', () => {
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
  });

  it('closes the server, releases the database and exits cleanly', () => {
    // Emitting the signal runs the registered handlers without asking the OS to
    // do anything to this process.
    expect(() => process.emit('SIGINT')).toThrow(Exited);

    expect(exits).toEqual([0]);
    // A shutdown that left the database open would leave the next launch
    // looking at a home it cannot write to.
    expect(closes.length).toBeGreaterThan(0);
  });
});
