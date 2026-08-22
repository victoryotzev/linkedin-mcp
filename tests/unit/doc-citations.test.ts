import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The citations the documentation asks you to check.
//
// SECURITY.md, the threat model and the architecture notes all make claims of
// the form "this is enforced here", each with a `path:line` beside it. That
// style is the reason those documents are worth anything: a reader who does not
// believe a claim can open the file and look. It is also the reason they are
// fragile — a citation is a line number, and line numbers move whenever anyone
// edits above them.
//
// They have drifted twice already: once when the tree was reformatted, and once
// when a bug fix added twenty lines to backupService.ts. Both times the prose
// stayed true and the pointer stopped landing on it, which is the failure mode
// that matters here — a reader who checks one claim, lands on a closing brace,
// and reasonably discounts every other claim in the document.

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

/**
 * `path/to/file.ts:12`, `:12-34`, and the multi-part `:12,20-25,40` form the
 * documents use when one claim rests on several places in a file. Every part is
 * checked, not just the first — a citation whose second range has drifted is
 * exactly as misleading as one whose first has.
 */
const CITATION =
  /`?([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|mjs|js|ps1|css|json))`?:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.impeccable']);

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, found);
    else if (entry.endsWith('.md')) found.push(full);
  }
  return found;
}

interface Citation {
  /** Where the claim is made. */
  source: string;
  sourceLine: number;
  /** What it points at. */
  target: string;
  start: number;
  end: number | null;
}

function citations(): Citation[] {
  const out: Citation[] = [];
  for (const file of markdownFiles(repositoryRoot)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(CITATION)) {
        const source = file.slice(repositoryRoot.length + 1).replaceAll('\\', '/');
        for (const part of (match[2] as string).split(',')) {
          const [from, to] = part.split('-');
          out.push({
            source,
            sourceLine: index + 1,
            target: match[1] as string,
            start: Number(from),
            end: to === undefined ? null : Number(to),
          });
        }
      }
    });
  }
  return out;
}

// Read once: every case below asks a different question of the same set.
const ALL = citations();

/** A line that carries no claim — blank, or pure punctuation closing a block. */
function isEmptyOfMeaning(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || /^[})\];,]+$/.test(trimmed);
}

describe('the file:line citations in the documentation', () => {
  it('finds citations at all, so a passing suite is not an empty one', () => {
    // Guards the regex itself. If it stopped matching, every case below would
    // pass over an empty list and report nothing wrong with a broken document.
    expect(ALL.length).toBeGreaterThan(50);
  });

  it('names files that exist', () => {
    const missing = ALL.filter((c) => !existsSync(join(repositoryRoot, c.target))).map(
      (c) => `${c.source}:${c.sourceLine} cites ${c.target}, which does not exist`,
    );
    expect(missing).toEqual([]);
  });

  it('stays inside the files it names', () => {
    const past: string[] = [];
    for (const c of ALL) {
      const path = join(repositoryRoot, c.target);
      if (!existsSync(path)) continue;
      const length = readFileSync(path, 'utf8').split(/\r?\n/).length;
      const last = c.end ?? c.start;
      if (last > length) {
        past.push(
          `${c.source}:${c.sourceLine} cites ${c.target}:${c.start}-${last}, which has ${length} lines`,
        );
      }
    }
    expect(past).toEqual([]);
  });

  it('lands on a line that carries the claim, not on a brace or a blank', () => {
    // The one that actually catches drift. A citation whose first line is `}`
    // or empty has slid off whatever it was pointing at; the prose beside it is
    // usually still correct, which is exactly why nobody notices.
    const adrift: string[] = [];
    for (const c of ALL) {
      const path = join(repositoryRoot, c.target);
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, 'utf8').split(/\r?\n/);
      const line = lines[c.start - 1];
      if (line === undefined) continue;
      if (isEmptyOfMeaning(line)) {
        adrift.push(
          `${c.source}:${c.sourceLine} cites ${c.target}:${c.start}, which is ${JSON.stringify(line.trim())}`,
        );
      }
    }
    expect(adrift).toEqual([]);
  });
});
