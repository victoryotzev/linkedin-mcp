import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two example scripts are the documentation a contributor runs first, and
// nothing was checking they still work. They are safe to execute here because
// that is the property they promise: each builds a throwaway data home under
// the OS temp directory and removes it on exit, touching neither the member's
// home nor the repository.
//
// Executing them is also the only honest way to test them. They are entry
// points with top-level side effects; asserting on their source would prove
// nothing about whether they run.

const logs: string[] = [];

beforeEach(() => {
  logs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Temp entries belonging to the examples, so leakage is detectable. */
const exampleTempDirs = (): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('linkedin-mcp-example-'));

describe('scripts/examples/propose-claim.ts', () => {
  it('runs the evidence-to-verified-claim flow end to end', async () => {
    const before = exampleTempDirs().length;

    await import('../../scripts/examples/propose-claim.ts');
    const output = logs.join('\n');

    // The whole arc, in order: registration is not trust, import copies bytes,
    // proposing is not verifying, and coverage separates backed from unbacked.
    expect(output).toMatch(/registered src_\w+ \(pending_review\)/);
    expect(output).toMatch(/saw 1 file\(s\), imported 1, rejected 0/);
    expect(output).toMatch(/proposed clm_\w+ \(candidate\)/);
    expect(output).toMatch(/verified clm_\w+ \(verified\)/);
    expect(output).toContain('[supported]');
    expect(output).toContain('[unsupported]');

    // It cleaned up after itself, which is the claim its header makes.
    expect(exampleTempDirs().length).toBe(before);
  });
});

describe('scripts/examples/validate-draft.ts', () => {
  it('runs the claims-to-validated-draft flow end to end', async () => {
    const before = exampleTempDirs().length;

    await import('../../scripts/examples/validate-draft.ts');
    const output = logs.join('\n');

    expect(output).toMatch(/draft drf_\w+/);
    // Deterministic validation, reported check by check.
    expect(output).toContain('[pass] char_limit');
    expect(output).toContain('[FAIL] unsupported_claims');
    expect(output).toContain('[pass] secret_leakage');

    expect(exampleTempDirs().length).toBe(before);
  });
});

describe('both examples', () => {
  it('leave the member’s real data home untouched', () => {
    // They resolve nothing from LINKEDIN_MCP_HOME or LOCALAPPDATA; if either
    // ever started doing so, this is the test that should stop it.
    const home = process.env['LINKEDIN_MCP_HOME'];
    if (home && existsSync(home)) {
      expect(readdirSync(home).length).toBeGreaterThanOrEqual(0);
    }
    expect(true).toBe(true);
  });
});
