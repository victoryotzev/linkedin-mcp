import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Onboarding a single document rather than a folder.
//
// The script proves the member's original was not touched, and how it proves
// that depends on what was pointed at: a file is fingerprinted by hashing its
// bytes, a directory by the mtime of its root, because the scanner opens a
// directory read-only and never writes into it. Getting the file branch wrong
// would mean claiming an untouched original on the strength of a timestamp that
// an import could legitimately move.

let home: string;
let document: string;
const logs: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-onedoc-'));
  const dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-onedoc-src-'));
  document = join(dir, 'cv.md');
  writeFileSync(document, '# Alex Rivera\n\nBuilds local-first evidence tooling.\n', 'utf8');

  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of [home, join(document, '..')]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS reclaims it */
    }
  }
});

describe('scripts/onboard-import.ts, pointed at one file', () => {
  it('hashes the bytes to prove the original was left alone', async () => {
    const originalArgv = process.argv;
    process.argv = [
      originalArgv[0]!,
      'onboard-import.ts',
      document,
      'document',
      'personal_doc',
      'CV',
    ];

    try {
      await import('../../scripts/onboard-import.ts');
    } finally {
      process.argv = originalArgv;
    }

    const reported = JSON.parse(logs.join('\n')) as {
      source_id: string;
      label: string;
      original_untouched: boolean;
      report: { files_imported: number };
    };

    expect(reported.source_id).toMatch(/^src_/);
    expect(reported.label).toBe('CV');
    expect(reported.report.files_imported).toBe(1);
    // A byte hash, not a timestamp: importing copies bytes into the store and
    // leaves the member's own file exactly where it was.
    expect(reported.original_untouched).toBe(true);
    expect(existsSync(document)).toBe(true);
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
  }, 60_000);
});
