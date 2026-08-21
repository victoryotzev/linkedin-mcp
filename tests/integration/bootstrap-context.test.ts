import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the MCP server does at start, and the one thing it can do at the end.
//
// Boot is where a member's home is created, migrated and swept, and where the
// server decides out loud whether search will be full-text or a LIKE scan. The
// end is the full purge: it closes the database before deleting the home,
// because Windows will not remove an open file and a half-erased home is the
// worst possible outcome for an operation whose whole promise is that nothing
// survives it.

let fts5Available = true;

vi.mock('@linkedin-mcp/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@linkedin-mcp/db')>();
  return {
    ...actual,
    // FTS5 is a compile-time SQLite option. A member's Node build may simply
    // not have it, and there is no way to ask for that at runtime.
    openDatabase: (path: string) => {
      const opened = actual.openDatabase(path);
      return { ...opened, fts5: opened.fts5 && fts5Available };
    },
  };
});

const { bootstrap, contextActor } = await import('../../linkedin-mcp-server/src/bootstrap.ts');

let home: string;
const logs: string[] = [];
const exits: number[] = [];

beforeEach(() => {
  fts5Available = true;
  logs.length = 0;
  exits.length = 0;
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-boot-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  // stdout carries protocol JSON-RPC only, so every diagnostic goes to stderr.
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    return undefined as never;
  }) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('booting against a home that does not exist yet', () => {
  it('creates it, migrates it, and says what it did', () => {
    const ctx = bootstrap();

    try {
      expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
      expect(ctx.home).toBe(home);
      expect(contextActor(ctx)).toBe('mcp_host');
      // The boot line is the only thing a member sees when the server starts
      // under a host that hides stdio, so it carries the home it chose.
      expect(logs.join('\n')).toContain(`boot: home=${home}`);
      expect(logs.join('\n')).toMatch(/migrations_applied=\[/);
    } finally {
      ctx.db.close();
    }
  });

  it('says out loud when search will fall back to a LIKE scan', () => {
    fts5Available = false;

    const ctx = bootstrap();

    try {
      expect(ctx.fts5).toBe(false);
      // Silence here would leave a member with a search box that quietly finds
      // less than it used to, and no way to know why. The line also says what
      // is NOT affected, because the alternative reading is much worse.
      expect(logs.join('\n')).toMatch(/FTS5 unavailable/);
      expect(logs.join('\n')).toMatch(/safety paths unaffected/);
    } finally {
      ctx.db.close();
    }
  });
});

describe('the full purge the MCP server schedules', () => {
  it('closes the database first, then deletes the home and exits', async () => {
    const ctx = bootstrap();
    expect(existsSync(join(home, 'data'))).toBe(true);
    expect(ctx.scheduleFullPurge).toBeTruthy();

    ctx.scheduleFullPurge?.();

    // Scheduled rather than performed, so the tool response is written first.
    expect(existsSync(join(home, 'data'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(existsSync(join(home, 'data'))).toBe(false);
    expect(logs.join('\n')).toMatch(/full purge complete/);
    expect(exits).toContain(0);
  }, 30_000);

  it('ignores a second request, because the first one is already running', async () => {
    const ctx = bootstrap();

    ctx.scheduleFullPurge?.();
    ctx.scheduleFullPurge?.();
    await new Promise((resolve) => setTimeout(resolve, 900));

    // Two timers would race two deletions of the same tree, and the second
    // would report a failure for work the first had already done.
    expect(exits).toEqual([0]);
  }, 30_000);
});
