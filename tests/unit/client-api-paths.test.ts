import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `request()` in lib/api.ts prefixes every path with `/api`. A caller that
// includes the prefix itself produces `/api/api/...`, which 404s.
//
// This is not hypothetical: the Setup screen shipped with all four of its calls
// double-prefixed, so its readiness panel, its upload, its describe box and the
// first-run redirect were each broken. Nothing caught it, because the redirect
// swallowed its own failure and the route tests called the API directly rather
// than through the client. A grep is a blunt instrument, but it is the one that
// would have failed on the day.

const CLIENT_FILES = execSync(
  'git ls-files "linkedin-dashboard/src/client/**/*.ts" "linkedin-dashboard/src/client/**/*.tsx"',
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);

/** The helpers that add the prefix themselves. */
const WRAPPED = /(api\.(get|post|upload)|useResource<[^>]*>|mutation\.run<[^>]*>)\s*\(/;

const carriesPrefix = (line: string): boolean =>
  line.includes("'/api/") || line.includes('"/api/') || line.includes('`/api/');

describe('client request paths', () => {
  it('found a client tree worth checking', () => {
    expect(CLIENT_FILES.length).toBeGreaterThanOrEqual(20);
  });

  it('never passes a path that already carries the /api prefix', () => {
    const offenders: string[] = [];

    for (const file of CLIENT_FILES) {
      // lib/api.ts is where the prefix is added, so it is the one place the
      // literal legitimately appears.
      if (file.endsWith('lib/api.ts')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (WRAPPED.test(line) && carriesPrefix(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });

  it('leaves the one deliberate direct fetch alone', () => {
    // A direct fetch() must spell the full path, and System.tsx uses one on
    // purpose for purge-all, whose body is a typed phrase rather than the
    // confirm boolean every other mutation sends. Documenting it here means
    // removing it is a decision rather than an accident, and stops the rule
    // above from being quietly widened to swallow it.
    const system = readFileSync('linkedin-dashboard/src/client/screens/System.tsx', 'utf8');
    expect(system).toContain("await fetch('/api/purge-all'");
  });

  it('adds the prefix exactly once, in one place', () => {
    const api = readFileSync('linkedin-dashboard/src/client/lib/api.ts', 'utf8');
    expect(api.split('`/api${path}`').length - 1).toBe(1);
  });
});
