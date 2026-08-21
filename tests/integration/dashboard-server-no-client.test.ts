import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Starting the dashboard with no client build on disk.
//
// This is the only surface that can approve a publication. A dashboard that
// comes up and serves a blank page is worse than one that does not come up at
// all: the member sees a window, concludes the product is broken in some
// unknown way, and has no idea that the fix is one build command. So the server
// refuses to start and says what to run.
//
// The bind and the asset provider are stubbed; the refusal itself is the real
// module-scope code.

const exits: number[] = [];
const logs: string[] = [];
let home: string;
let importError: unknown = null;

vi.mock('@hono/node-server', () => ({
  serve: (options: { fetch: Hono['fetch'] }, callback?: () => void) => {
    void options;
    callback?.();
    return { on: () => {}, close: (done?: () => void) => done?.() };
  },
}));

vi.mock('../../linkedin-dashboard/src/assets.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../linkedin-dashboard/src/assets.ts')>();
  return {
    ...actual,
    // MissingClientBuildError stays the real class, because the guard is an
    // instanceof check and a look-alike would pass it for the wrong reason.
    createAssetProvider: () => {
      throw new actual.MissingClientBuildError('C:\\fixture\\dist\\client\\app.js');
    },
  };
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-no-client-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  // Recorded rather than performed: with a real exit nothing after it could be
  // asserted, and the module keeps running instead — which is why the import
  // below is expected to reject.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    return undefined;
  }) as never);

  await import('../../linkedin-dashboard/src/server.ts').catch((err: unknown) => {
    importError = err;
  });
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

describe('booting without a client build', () => {
  it('refuses to start rather than serving a blank approval surface', () => {
    expect(exits).toContain(1);
  });

  it('names the file it could not find and the command that makes it', () => {
    const printed = logs.join('\n');

    // "Failed to start" would send the member to the issue tracker. The build
    // command sends them to a working dashboard.
    expect(printed).toMatch(/client asset not found/i);
    expect(printed).toMatch(/npm run build/i);
    expect(printed).toMatch(/\[dashboard\]/);
  });

  it('does not fall through into serving anything', () => {
    // The guard exits; with exit stubbed the original error keeps propagating,
    // which is the same "nothing is served" outcome by a different route.
    expect(importError).toBeTruthy();
  });
});
