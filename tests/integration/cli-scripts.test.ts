import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The two scripts a member actually types, run for real against a throwaway
// home. Both do their work at import time, so this is the only way to reach
// them; both are also the ones most likely to be run by mistake against real
// data, which is why the home is stubbed before either is loaded.

let home: string;
let evidence: string;
const logs: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-cli-'));
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-evidence-'));
  writeFileSync(join(evidence, 'README.md'), '# Portfolio\n\nBuilt a backup tool.\n', 'utf8');

  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of [home, evidence]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS reclaims it */
    }
  }
});

const output = () => logs.join('\n');

describe('scripts/onboard-import.ts', () => {
  it('registers, enables and imports a source in one command', async () => {
    logs.length = 0;
    vi.stubGlobal('process', process);
    const originalArgv = process.argv;
    process.argv = [
      originalArgv[0]!,
      'onboard-import.ts',
      evidence,
      'folder',
      'own_repo',
      'Portfolio',
    ];

    try {
      await import('../../scripts/onboard-import.ts');
    } finally {
      process.argv = originalArgv;
    }

    const reported = JSON.parse(output()) as {
      source_id: string;
      label: string;
      original_untouched: boolean;
      report: { files_imported: number };
    };

    expect(reported.source_id).toMatch(/^src_/);
    expect(reported.label).toBe('Portfolio');
    expect(reported.report.files_imported).toBeGreaterThanOrEqual(1);
    // The claim this script prints, and the one that matters: importing copies
    // bytes into the store and leaves the member's own files alone.
    expect(reported.original_untouched).toBe(true);
    expect(existsSync(join(evidence, 'README.md'))).toBe(true);
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
  });
});

describe('scripts/dma-sync.ts', () => {
  it('refuses to open a socket when the read lane is not verified', async () => {
    logs.length = 0;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // The capability gate runs before the client is constructed, so a closed
    // lane must not produce a request at all — not a request that then fails.
    await expect(import('../../scripts/dma-sync.ts')).rejects.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
