import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { configureLane, createSecretStore, seedCapabilities } from '@linkedin-mcp/domain';

// The two entry-point scripts a member runs by hand, driven all the way
// through rather than only up to their first refusal.
//
// Both run their work at import time, so there is no function to call: they are
// pointed at a throwaway home and imported. dma-sync reads the real vault, so
// the credential path is real and only the socket is replaced.

const IS_WINDOWS = process.platform === 'win32';

function dpapiAvailable(): boolean {
  if (!IS_WINDOWS) return false;
  const systemRoot = process.env['SystemRoot'];
  const exe = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const probe = spawnSync(
    exe,
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; exit 0'],
    { windowsHide: true, timeout: 20_000 },
  );
  return probe.status === 0;
}

const HAS_DPAPI = dpapiAvailable();
const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

const PROFILE_ROW = {
  'First Name': 'Alex',
  'Last Name': 'Rivera',
  Headline: 'Full-Stack Web Developer',
  Summary: 'Builds local-first systems.',
};
const SHARE_ROW = {
  Date: '2026-03-01 10:00:00',
  ShareCommentary: 'A post about renovating deployed software rather than rewriting it.',
  ShareLink: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
};

let home: string;
let db: SqliteDriver;
const logs: string[] = [];
const errors: string[] = [];
const requests: string[] = [];
let exitCode: number | null = null;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-scripts-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    return undefined as never;
  }) as never);

  const opened = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  db = opened.db;
  migrate(db);
  seedCapabilities(db);
  if (HAS_DPAPI) {
    await configureLane(db, createSecretStore(db, home), {
      lane: 'read',
      client_id: 'test-client-id-read',
      access_token: TOKEN,
    });
  }
  // The gate, opened the way a verified probe would open it.
  db.run(
    `UPDATE capabilities SET status = 'verified', blockers_json = '[]'
      WHERE feature IN ('linkedin.dma_snapshot', 'linkedin.dma_changelog')`,
  );
  db.close();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

const output = () => logs.join('\n');

describe('scripts/onboard-import.ts, called wrongly', () => {
  it('prints the usage line and exits with a failing code', async () => {
    errors.length = 0;
    const originalArgv = process.argv;
    process.argv = [originalArgv[0]!, 'onboard-import.ts'];

    try {
      // With process.exit stubbed the module keeps running and fails on the
      // path it was never given, which is the same "nothing happened" outcome.
      await import('../../scripts/onboard-import.ts').catch(() => undefined);
    } finally {
      process.argv = originalArgv;
    }

    // A script that took four positional arguments and silently did nothing
    // would leave a member believing their documents were imported.
    expect(errors.join('\n')).toMatch(/usage: tsx scripts\/onboard-import\.ts/);
    expect(exitCode).toBe(2);
  });
});

describe.runIf(HAS_DPAPI)('scripts/dma-sync.ts, with the lane open', () => {
  it('reads the token from the vault, syncs, and prints what came back', async () => {
    logs.length = 0;
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      const domain = /domain=([A-Z_]+)/.exec(url)?.[1] ?? 'PROFILE';
      const page = Number(/start=(\d+)/.exec(url)?.[1] ?? '0');
      // The walk ends on an empty page; answering with rows forever runs to the
      // page cap and reports a snapshot that never terminated.
      const rows =
        page > 0
          ? []
          : domain === 'PROFILE'
            ? [PROFILE_ROW]
            : domain === 'MEMBER_SHARE_INFO'
              ? [SHARE_ROW]
              : [];
      return new Response(
        JSON.stringify({ elements: [{ snapshotDomain: domain, snapshotData: rows }], paging: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await import('../../scripts/dma-sync.ts');

    const reported = output();
    // Every number it prints is one a member reads to decide whether the sync
    // was worth trusting: what LinkedIn returned, what that became here, and
    // how stale the result already is.
    expect(reported).toMatch(/domains:/);
    expect(reported).toMatch(/row\(s\) fetched/);
    expect(reported).toMatch(/snapshot: snp_/);
    expect(reported).toMatch(/freshness: /);
    expect(reported).toMatch(/posts on file: /);
    // Every request went to LinkedIn's snapshot endpoint and nowhere else.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((u) => u.startsWith('https://api.linkedin.com/'))).toBe(true);
  }, 120_000);
});
