import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanRepo } from '@linkedin-mcp/importers';

// The scanner decides two things: which files are worth copying into the
// artifact store as evidence, and what the repository's shape is. Both feed
// claims, so a scanner that quietly walks node_modules inflates a member's
// reported scale, and one that follows a junction escapes the source root.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const file = (relpath: string, body = 'x') => {
  const full = join(root, relpath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
  return full;
};

const scan = (maxBytes = 1024 * 1024) => scanRepo(root, maxBytes);

describe('evidence selection', () => {
  it('picks the manifests and documents that claims actually cite', () => {
    file('README.md');
    file('package.json', '{}');
    file('pyproject.toml');
    file('Dockerfile');
    file('LICENSE');
    file('CHANGELOG.md');
    file('SECURITY.md');
    file('tsconfig.base.json', '{}');

    const { evidenceFiles } = scan();

    for (const expected of [
      'README.md',
      'package.json',
      'pyproject.toml',
      'Dockerfile',
      'LICENSE',
      'CHANGELOG.md',
      'SECURITY.md',
      'tsconfig.base.json',
    ]) {
      expect(evidenceFiles, `${expected} should be evidence`).toContain(expected);
    }
  });

  it('leaves ordinary source files out of the evidence set', () => {
    file('src/index.ts', 'export const a = 1;');
    file('src/deep/nested/thing.ts', 'export const b = 2;');

    const { evidenceFiles, stats } = scan();

    // Source files still count towards scale; they are simply not copied.
    expect(evidenceFiles).toEqual([]);
    expect(stats.files_total).toBe(2);
    expect(stats.files_by_extension['.ts']).toBe(2);
  });

  it('includes CI workflows and docs from their specific directories', () => {
    file('.github/workflows/ci.yml');
    file('.github/workflows/notes.txt');
    file('docs/architecture.md');
    file('docs/deep/guide.rst');
    file('docs/diagram.png');

    const { evidenceFiles } = scan();
    const normalised = evidenceFiles.map((p) => p.split('\\').join('/'));

    expect(normalised).toContain('.github/workflows/ci.yml');
    expect(normalised).toContain('docs/architecture.md');
    expect(normalised).toContain('docs/deep/guide.rst');
    // The directory rules are file-typed, not blanket.
    expect(normalised).not.toContain('.github/workflows/notes.txt');
    expect(normalised).not.toContain('docs/diagram.png');
  });
});

describe('directories that are skipped', () => {
  it('skips vendored and build trees rather than counting them as the member’s work', () => {
    file('README.md');
    for (const dir of [
      'node_modules',
      'dist',
      'build',
      'coverage',
      'venv',
      'out',
      'target',
      'vendor',
    ]) {
      file(`${dir}/thing.ts`);
      file(`${dir}/README.md`);
    }

    const { evidenceFiles, stats } = scan();

    expect(evidenceFiles).toEqual(['README.md']);
    expect(stats.files_total).toBe(1);
    expect(stats.dirs_skipped.length).toBeGreaterThanOrEqual(8);
  });

  it('skips hidden directories, but keeps .github', () => {
    file('.git/config');
    file('.venv/lib/thing.py');
    file('.claude/settings.local.json', '{}');
    file('.github/workflows/ci.yml');

    const { evidenceFiles, stats } = scan();
    const normalised = evidenceFiles.map((p) => p.split('\\').join('/'));

    expect(normalised).toEqual(['.github/workflows/ci.yml']);
    // Only the workflow was counted; nothing from .git, .venv or .claude.
    expect(stats.files_total).toBe(1);
  });
});

describe('size and shape reporting', () => {
  it('counts extensions, grouping extensionless files under their own key', () => {
    file('a.ts');
    file('b.ts');
    file('c.py');
    file('Makefile');

    const { stats } = scan();

    expect(stats.files_total).toBe(4);
    expect(stats.files_by_extension['.ts']).toBe(2);
    expect(stats.files_by_extension['.py']).toBe(1);
    // However it is keyed, an extensionless file must still be counted once.
    const counted = Object.values(stats.files_by_extension).reduce((n, v) => n + v, 0);
    expect(counted).toBe(4);
  });

  it('still counts a file too large to ingest, but does not offer it as evidence', () => {
    file('README.md', 'x'.repeat(4096));

    const small = scanRepo(root, 10);

    // Scale is a fact about the repository; ingestion is a separate decision
    // bounded by the size ceiling.
    expect(small.stats.files_total).toBe(1);
    expect(small.evidenceFiles).not.toContain('README.md');
  });

  it('returns empty results for an empty repository', () => {
    const { evidenceFiles, stats } = scan();

    expect(evidenceFiles).toEqual([]);
    expect(stats.files_total).toBe(0);
    expect(stats.files_by_extension).toEqual({});
  });
});

describe('reparse points', () => {
  it('does not follow a symlinked directory out of the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'linkedin-mcp-outside-'));
    try {
      writeFileSync(join(outside, 'README.md'), 'secret neighbour', 'utf8');
      file('README.md', 'the real one');

      let linked = false;
      try {
        symlinkSync(outside, join(root, 'linked'), 'junction');
        linked = true;
      } catch {
        // Creating a junction can require privileges this run does not have.
        // Skipping is honest; silently passing would not be.
      }
      if (!linked) return;

      const { evidenceFiles, stats } = scan();

      // The neighbour's README must not appear as the member's evidence.
      expect(evidenceFiles).toEqual(['README.md']);
      expect(stats.files_total).toBe(1);
      expect(stats.reparse_points_skipped.length).toBeGreaterThan(0);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
