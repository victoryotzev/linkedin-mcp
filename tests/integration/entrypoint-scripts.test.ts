import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The remaining entry-point scripts, executed rather than inspected.
//
// These run their work at import time, so there is no exported function to
// call: asserting on their source would prove they parse, not that they work.
// Each is pointed at a throwaway LINKEDIN_MCP_HOME first, so none of them can
// reach the member's real data.
//
// seed-eval and run-eval are also driven as subprocesses by eval-harness, which
// is what proves the documented CLI invocation. Running them in process here is
// what proves the code inside them, and is what a coverage report can see.

let home: string;
const logs: string[] = [];
let exitCode: number | null = null;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-entry-'));
  vi.stubEnv('LINKEDIN_MCP_HOME', home);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  // run-eval ends with process.exit; letting that through would end the run.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    return undefined as never;
  }) as never);
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const output = () => logs.join('\n');

describe('scripts/dev-migrate.ts', () => {
  it('applies the full migration set to a fresh home and reports it', async () => {
    logs.length = 0;
    await import('../../scripts/dev-migrate.ts');

    const reported = output();
    // Printed as JSON, so path separators arrive escaped: compare the parsed
    // value rather than substring-matching the raw line.
    // A fresh home applies every migration; the count is the schema's, not a
    // number this test should pin.
    const parsed = JSON.parse(reported.split('\n')[0]!) as { home: string; applied: number[] };
    expect(parsed.home).toBe(home);
    expect(parsed.applied.length).toBeGreaterThanOrEqual(19);
    expect(parsed.applied).toContain(19);

    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
    // It also prints the schema it just produced, which is the point of it.
    expect(reported).toContain('linkedin_accounts columns:');
    expect(reported).toContain('tables:');
  });
});

describe('scripts/seed-eval.ts', () => {
  it('builds the synthetic evaluation corpus', async () => {
    logs.length = 0;
    await import('../../scripts/seed-eval.ts');

    // Everything it creates is invented; the corpus exists so eval answers are
    // derivable from the server rather than guessable.
    expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
    expect(output().length).toBeGreaterThan(0);
  });
});

describe('scripts/run-eval.ts', () => {
  it('verifies every eval answer against the seeded corpus', async () => {
    logs.length = 0;
    exitCode = null;
    await import('../../scripts/run-eval.ts');

    const reported = output();
    expect(reported.length).toBeGreaterThan(0);
    // The harness exists to prove the answers are derivable. A non-zero exit
    // here would mean the corpus and the question set have drifted apart.
    expect(exitCode).toBe(0);
  });
});

describe('scripts/gen-third-party-notices.ts', () => {
  it('regenerates the notices file from the lockfile, idempotently', async () => {
    const path = 'THIRD-PARTY-NOTICES.md';
    const before = readFileSync(path, 'utf8');
    logs.length = 0;

    await import('../../scripts/gen-third-party-notices.ts');

    const after = readFileSync(path, 'utf8');
    // Idempotent by construction: same lockfile in, same notices out. If this
    // ever fails, the committed file is stale rather than the generator broken.
    expect(after).toBe(before);
    expect(after).toContain('# Third-party notices');
    expect(after).toContain('`yauzl@');
    expect(after).toContain('`hono@');
    expect(output()).toMatch(/wrote THIRD-PARTY-NOTICES\.md/);
  });
});
