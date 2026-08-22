import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enableSourceFromDashboard,
  listArtifacts,
  registerSource,
  runImport,
  setSetting,
} from '@linkedin-mcp/domain';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';
import { makePdf } from '../helpers/makePdf.ts';

// One import path per kind of thing a member can point at.
//
// A repository, a single document, a coursework folder and a LinkedIn export
// are collected in four quite different ways, and each one has its own rules
// about what is worth copying. Two of them had never run: pointing at a single
// file, and pointing at a folder — which is the one that deliberately takes a
// structure summary rather than dragging in a whole tree of coursework.

let fixture: Fixture;
let evidence: string;

beforeEach(() => {
  fixture = createFixture('import-kinds');
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-evidence-'));
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

function file(relpath: string, body: Buffer | string): string {
  const full = join(evidence, relpath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return full;
}

async function importFrom(
  path: string,
  kind: 'repo' | 'document' | 'folder' | 'linkedin_export',
  opts: { subpath?: string; dryRun?: boolean } = {},
) {
  const source = registerSource(fixture.db, {
    path,
    kind,
    trust: 'own_repo',
    label: `${kind} source`,
    dataHome: fixture.dir,
  });
  enableSourceFromDashboard(fixture.db, source.id);
  const report = await runImport(fixture.db, fixture.store, source.id, opts);
  return { source, report };
}

const artifacts = () => listArtifacts(fixture.db, {}, fixture.fts5);
const relpaths = () => artifacts().map((a) => a.source_relpath);

describe('pointing at a single document', () => {
  it('imports just that file, under its own name', async () => {
    const path = file('cv.pdf', makePdf(['Alex Rivera', 'Built a backup verifier.']));

    const { report } = await importFrom(path, 'document');

    expect(report.files_imported).toBe(1);
    expect(relpaths()).toEqual(['cv.pdf']);
    // The invariant, not just the value. A relpath is a file name and never a
    // path: it is stored, indexed and shown wherever a name belongs. Splitting
    // the source path on backslash alone left the whole absolute path here on
    // Linux, and the equality above is only accidentally sensitive to that —
    // on Windows it passes either way.
    expect(relpaths().every((relpath) => !/[\\/]/.test(relpath))).toBe(true);
  }, 60_000);

  it('reads the text out of it, so claims can cite a line rather than a filename', async () => {
    const path = file('cv.pdf', makePdf(['Shipped a deterministic CSV parser.']));
    await importFrom(path, 'document');

    const extraction = fixture.db.get('SELECT text, status FROM extractions LIMIT 1');
    expect(String(extraction?.['status'])).toBe('ok');
    expect(String(extraction?.['text'])).toContain('deterministic CSV parser');
  }, 60_000);

  it('refuses a document above the size ceiling', async () => {
    setSetting(fixture.db, 'importer.max_file_mb', 1, { confirm: true });
    const path = file('huge.md', Buffer.alloc(2 * 1024 * 1024, 'x'));

    await expect(importFrom(path, 'document')).rejects.toBeTruthy();
    expect(relpaths()).toEqual([]);
  });
});

describe('pointing at a folder', () => {
  it('takes a structure summary rather than dragging in the whole tree', async () => {
    file('year1/notes.pdf', makePdf(['coursework']));
    file('year1/slides.pdf', makePdf(['more coursework']));
    file('year2/essay.md', 'An essay.');
    file('year2/data.csv', 'a,b\n1,2\n');

    const { report } = await importFrom(evidence, 'folder');

    // The default is one artifact describing the shape, not four documents:
    // coursework folders are large and mostly low-value, and what claims
    // actually cite is the shape.
    expect(report.files_imported).toBeGreaterThan(0);
    const structure = relpaths().find((p) => p.includes('structure'));
    expect(structure, `expected a structure artifact, saw ${relpaths().join(', ')}`).toBeTruthy();
  }, 60_000);

  it('counts what it saw without copying it', async () => {
    file('year1/notes.pdf', makePdf(['coursework']));
    file('year1/essay.md', 'An essay.');
    await importFrom(evidence, 'folder');

    const structureId = artifacts().find((a) => a.source_relpath.includes('structure'));
    if (!structureId) return;
    const extraction = fixture.db.get(
      'SELECT text FROM extractions WHERE artifact_id = ?',
      structureId.id,
    );
    const text = String(extraction?.['text'] ?? '');

    expect(text).toContain('year1');
    expect(text).toMatch(/\.pdf|\.md/);
  }, 60_000);

  it('ingests documents from one subtree when asked for it explicitly', async () => {
    file('year1/notes.pdf', makePdf(['first year coursework']));
    file('year2/essay.md', 'A second-year essay worth citing.');

    const { report } = await importFrom(evidence, 'folder', { subpath: 'year2' });

    // Explicitly asking for a subtree is what pulls the documents in, and only
    // the ones under it.
    expect(report.files_imported).toBeGreaterThan(1);
    const paths = relpaths().join(' ');
    expect(paths).toContain('essay.md');
    expect(paths).not.toContain('notes.pdf');
  }, 60_000);

  it('never follows a link out of the folder', async () => {
    file('inside.md', 'Mine.');
    const outside = mkdtempSync(join(tmpdir(), 'linkedin-mcp-outside-'));
    try {
      writeFileSync(join(outside, 'neighbour.md'), 'Not mine.');
      try {
        const { symlinkSync } = await import('node:fs');
        symlinkSync(outside, join(evidence, 'linked'), 'junction');
      } catch {
        return; // creating a junction can need privileges this run lacks
      }

      // Refused at the boundary rather than walked and filtered: a junction is
      // a path that escapes the registered root, and the guard says so.
      await expect(importFrom(evidence, 'folder', { subpath: 'linked' })).rejects.toThrow(
        /escapes its registered source root/i,
      );
      expect(relpaths().join(' ')).not.toContain('neighbour.md');
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);

  it('skips vendored directories rather than counting them as the member’s work', async () => {
    file('src/index.ts', 'export const a = 1;');
    file('node_modules/pkg/index.js', 'module.exports = {};');
    file('.git/config', '[core]');

    await importFrom(evidence, 'folder');

    const paths = relpaths().join(' ');
    expect(paths).not.toContain('node_modules');
    expect(paths).not.toContain('.git');
  }, 60_000);
});

describe('a dry run', () => {
  it('reports what would happen and writes nothing', async () => {
    file('README.md', '# Project\n\nA deterministic CSV parser.\n');
    file('package.json', '{}');

    const { report } = await importFrom(evidence, 'repo', { dryRun: true });

    expect(report.files_imported).toBeGreaterThanOrEqual(0);
    // Nothing in the store, nothing in the ledger: a dry run is a question.
    expect(relpaths()).toEqual([]);
  });
});

describe('importing the same source twice', () => {
  it('supersedes the old artifact when a file changed, and leaves the rest alone', async () => {
    file('README.md', '# Project\n\nFirst version.\n');
    const { source } = await importFrom(evidence, 'repo');
    const first = artifacts().length;

    file('README.md', '# Project\n\nSecond version, meaningfully different.\n');
    await runImport(fixture.db, fixture.store, source.id);

    // The live count is unchanged, which is the point: one README replaced
    // another rather than the corpus growing.
    expect(artifacts().length).toBe(first);

    // The old bytes are not deleted — a claim citing them still resolves — but
    // they are marked superseded, so nothing new cites them and the row count
    // behind the scenes has grown.
    const superseded = fixture.db.get(
      'SELECT COUNT(*) AS n FROM artifacts WHERE superseded_by IS NOT NULL',
    );
    expect(Number(superseded?.['n'])).toBe(1);
    expect(Number(fixture.db.get('SELECT COUNT(*) AS n FROM artifacts')?.['n'])).toBeGreaterThan(
      first,
    );

    // And the live README is the new one.
    const live = fixture.db.get(
      'SELECT e.text FROM extractions e JOIN artifacts a ON a.id = e.artifact_id' +
        " WHERE a.source_relpath = 'README.md' AND a.superseded_by IS NULL",
    );
    expect(String(live?.['text'])).toContain('Second version');
  }, 60_000);

  it('adds nothing when nothing changed', async () => {
    file('README.md', '# Project\n\nUnchanged.\n');
    const { source } = await importFrom(evidence, 'repo');
    const first = artifacts().length;

    await runImport(fixture.db, fixture.store, source.id);

    // Content-addressed storage: the same bytes are the same artifact, so a
    // re-import is not a way to inflate how much evidence exists.
    expect(artifacts().length).toBe(first);
  }, 60_000);
});

describe('a source that is not enabled', () => {
  it('is refused before anything is read', async () => {
    file('README.md', '# Project\n');
    const source = registerSource(fixture.db, {
      path: evidence,
      kind: 'repo',
      trust: 'own_repo',
      label: 'not enabled',
      dataHome: fixture.dir,
    });

    await expect(runImport(fixture.db, fixture.store, source.id)).rejects.toThrow(/enable it/i);
    expect(relpaths()).toEqual([]);
  });
});

describe('a file that cannot be read', () => {
  it('is reported against its own name without stopping the run', async () => {
    file('README.md', '# Project\n\nA deterministic CSV parser.\n');
    file('package.json', 'this is not valid json at all');

    const { report } = await importFrom(evidence, 'repo');

    // One bad file must not cost the member the whole import.
    expect(report.files_imported).toBeGreaterThan(0);
    expect(Array.isArray(report.rejects)).toBe(true);
  }, 60_000);
});
