import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult, SqlValue, SqliteDriver } from '@linkedin-mcp/db';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';

// What the importer does when the filesystem moves under it.
//
// The pipeline reads a directory, decides what to take, and only then pulls
// bytes. Between those steps a file can be deleted, locked by a backup agent,
// or replaced by something that is no longer readable — and on a member's own
// machine that is ordinary, not exotic. The rule throughout is per-file
// isolation: one unreadable file becomes a reject row with a reason, and the
// run carries on. A run that aborted on the first locked file would make an
// import of a real documents folder a coin toss.
//
// The marker names below drive a passthrough fs mock. Everything else on disk
// behaves normally.

const VANISH_LSTAT = 'VANISH-LSTAT';
const VANISH_READ = 'VANISH-READ';
const VANISH_DIR = 'VANISH-READDIR';
const FLAKY_STAT = 'FLAKY-STAT';

/** Counts stats per path, so one call can fail while its neighbours succeed. */
const statCalls = new Map<string, number>();

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT',
  });
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(VANISH_LSTAT)) throw enoent(String(path));
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    statSync: (path: unknown, ...rest: unknown[]) => {
      const key = String(path);
      if (key.includes(FLAKY_STAT)) {
        const seen = (statCalls.get(key) ?? 0) + 1;
        statCalls.set(key, seen);
        // The second read fails: the scan saw the file, and by the time its
        // timestamp was asked for it was gone.
        if (seen === 2) throw enoent(key);
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    readdirSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(VANISH_DIR)) throw enoent(String(path));
      return (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(VANISH_READ)) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, '${String(path)}'`), {
          code: 'EBUSY',
        });
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { registerSource, enableSourceFromDashboard, runImport, ingestBytes } = await import(
  '@linkedin-mcp/domain'
);

let fixture: Fixture;
let root: string;

beforeEach(() => {
  statCalls.clear();
  fixture = createFixture('import-edges');
  root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-tree-'));
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

function folderSource(label = 'coursework'): string {
  const source = registerSource(fixture.db, {
    path: root,
    kind: 'folder',
    trust: 'personal_doc',
    label,
    dataHome: fixture.dir,
  });
  enableSourceFromDashboard(fixture.db, source.id);
  return source.id;
}

const write = (relpath: string, text: string): void => {
  const full = join(root, relpath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text, 'utf8');
};

describe('walking a documents folder', () => {
  it('descends into subdirectories and takes what it finds', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    write('year-one/deeper/thesis.txt', 'A thesis on local-first tooling.');
    const sourceId = folderSource();

    const report = await runImport(fixture.db, fixture.store, sourceId, { subpath: 'year-one' });

    const paths = fixture.db
      .all('SELECT source_relpath FROM artifacts WHERE source_id = ?', sourceId)
      .map((r) => String(r['source_relpath']));
    expect(report.rejects).toEqual([]);
    expect(paths.some((p) => p.includes('notes.md'))).toBe(true);
    expect(paths.some((p) => p.includes('thesis.txt'))).toBe(true);
  }, 60_000);

  it('never descends into a vendored dependency tree', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    write('year-one/node_modules/left-pad/readme.md', 'Somebody else wrote this.');
    const sourceId = folderSource();

    await runImport(fixture.db, fixture.store, sourceId, { subpath: 'year-one' });

    // A coursework folder routinely contains a whole vendored tree. Importing
    // it would bury the member's own work in evidence they did not write, and
    // the claims built on it would be someone else's.
    const paths = fixture.db
      .all('SELECT source_relpath FROM artifacts WHERE source_id = ?', sourceId)
      .map((r) => String(r['source_relpath']));
    expect(paths.some((p) => p.includes('left-pad'))).toBe(false);
  }, 60_000);

  it('skips an entry it cannot stat, and takes the rest', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    write(`year-one/${VANISH_LSTAT}.md`, 'Deleted between the listing and the read.');
    const sourceId = folderSource();

    const report = await runImport(fixture.db, fixture.store, sourceId, { subpath: 'year-one' });

    // The listing and the stat are two separate syscalls; anything can happen
    // in between on a machine the member is also using.
    expect(report.rejects).toEqual([]);
    const paths = fixture.db
      .all('SELECT source_relpath FROM artifacts WHERE source_id = ?', sourceId)
      .map((r) => String(r['source_relpath']));
    expect(paths.some((p) => p.includes('notes.md'))).toBe(true);
    expect(paths.some((p) => p.includes(VANISH_LSTAT))).toBe(false);
  }, 60_000);

  it('records a file it cannot read as a reject, and imports the others', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    write(`year-one/${VANISH_READ}.md`, 'Held open by a backup agent.');
    const sourceId = folderSource();

    const report = await runImport(fixture.db, fixture.store, sourceId, { subpath: 'year-one' });

    // Named, with the reason, because a member who sees "42 of 43 imported"
    // needs to know which one and why to decide whether it mattered.
    const reject = report.rejects.find((r) => r.relpath.includes(VANISH_READ));
    expect(reject?.reason).toMatch(/EBUSY|busy|locked/i);
    const paths = fixture.db
      .all('SELECT source_relpath FROM artifacts WHERE source_id = ?', sourceId)
      .map((r) => String(r['source_relpath']));
    expect(paths.some((p) => p.includes('notes.md'))).toBe(true);
  }, 60_000);

  it('walks past a subdirectory it cannot list', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    mkdirSync(join(root, 'year-one', VANISH_DIR), { recursive: true });
    const sourceId = folderSource();

    const report = await runImport(fixture.db, fixture.store, sourceId, { subpath: 'year-one' });

    // A directory that lists as a directory and then refuses to be read is
    // ordinary on Windows: a permission-restricted profile folder, a OneDrive
    // placeholder, a mount that went away. It costs the member nothing to
    // carry on with the rest.
    expect(report.rejects).toEqual([]);
    const paths = fixture.db
      .all('SELECT source_relpath FROM artifacts WHERE source_id = ?', sourceId)
      .map((r) => String(r['source_relpath']));
    expect(paths.some((p) => p.includes('notes.md'))).toBe(true);
  }, 60_000);

  it('counts an unlistable directory as empty in the census', async () => {
    write('year-one/notes.md', 'Notes.');
    mkdirSync(join(root, VANISH_DIR), { recursive: true });
    const sourceId = folderSource();

    const report = await runImport(fixture.db, fixture.store, sourceId);

    // The census is what coursework claims cite, so it has to be produced even
    // when part of the tree will not open.
    expect(report.rejects).toEqual([]);
    const row = fixture.db.get(
      "SELECT sha256 FROM artifacts WHERE source_id = ? AND source_relpath = '__folder_structure__.json'",
      sourceId,
    );
    const census = new TextDecoder().decode(fixture.store.read(String(row?.['sha256'])));
    expect(JSON.parse(census)).toBeTruthy();
  }, 60_000);

  it('refuses a subpath that no longer exists rather than importing nothing quietly', async () => {
    write('year-one/notes.md', 'Notes.');
    const sourceId = folderSource();
    rmSync(join(root, 'year-one'), { recursive: true, force: true });

    // The subpath is the member saying "import this specific folder". Silently
    // importing zero files from it would read as "there was nothing in it".
    await expect(
      runImport(fixture.db, fixture.store, sourceId, { subpath: 'year-one' }),
    ).rejects.toThrow(/does not exist|unreadable/i);
  }, 60_000);

  it('leaves an unstattable entry out of the census', async () => {
    write('year-one/notes.md', 'Notes.');
    write(`${VANISH_LSTAT}.md`, 'Not countable.');
    const sourceId = folderSource();

    await runImport(fixture.db, fixture.store, sourceId);

    // The census is names and per-extension counts, never contents; an entry
    // it cannot stat is simply not counted rather than counted as zero of
    // something.
    const row = fixture.db.get(
      "SELECT sha256 FROM artifacts WHERE source_id = ? AND source_relpath = '__folder_structure__.json'",
      sourceId,
    );
    const census = new TextDecoder().decode(fixture.store.read(String(row?.['sha256'])));
    expect(census).not.toContain(VANISH_LSTAT);
  }, 60_000);
});

describe('a file whose timestamp cannot be read', () => {
  it('imports it with no original mtime rather than skipping it', async () => {
    write('README.md', '# A repository readme with something in it.');
    // Under docs/ so the repo scan collects it: the scan takes README-shaped
    // files and documentation, not everything on disk.
    write(`docs/${FLAKY_STAT}.md`, '# Notes that outlived their own timestamp.');
    const registered = registerSource(fixture.db, {
      path: root,
      kind: 'repo',
      trust: 'own_repo',
      label: 'a repository',
      dataHome: fixture.dir,
    });
    enableSourceFromDashboard(fixture.db, registered.id);

    await runImport(fixture.db, fixture.store, registered.id);

    // The mtime is provenance, not content. Losing it is worth recording as
    // unknown; refusing the file over it would lose the evidence itself.
    const row = fixture.db.get(
      'SELECT original_mtime FROM artifacts WHERE source_id = ? AND source_relpath LIKE ?',
      registered.id,
      `%${FLAKY_STAT}%`,
    );
    expect(row).toBeTruthy();
    expect(row?.['original_mtime']).toBeNull();
  }, 60_000);
});

describe('a source kind with nothing to collect', () => {
  it('takes nothing from a manual source', async () => {
    const source = registerSource(fixture.db, {
      path: root,
      kind: 'manual',
      trust: 'self_attested',
      label: 'what the member typed',
      dataHome: fixture.dir,
    });
    enableSourceFromDashboard(fixture.db, source.id);

    const report = await runImport(fixture.db, fixture.store, source.id);

    // Manual sources are filled by ingestBytes from the intake screen; a scan
    // of the path would be a scan of whatever folder happened to be recorded.
    expect(report.files_seen).toBe(0);
    expect(report.files_imported).toBe(0);
  });
});

describe('when another writer supersedes the same file first', () => {
  /** A driver that reports the supersede as already done by someone else. */
  function racingDriver(): SqliteDriver {
    const real = fixture.db;
    return {
      exec: (sql) => real.exec(sql),
      get: (sql, ...params) => real.get(sql, ...params),
      all: (sql, ...params) => real.all(sql, ...params),
      backupTo: (dest) => real.backupTo(dest),
      close: () => real.close(),
      run: (sql: string, ...params: SqlValue[]): RunResult => {
        if (sql.includes('SET superseded_by')) return { changes: 0, lastInsertRowid: 0 };
        return real.run(sql, ...params);
      },
    };
  }

  it('refuses to fork the chain, and says the import is worth re-running', async () => {
    const source = registerSource(fixture.db, {
      path: root,
      kind: 'manual',
      trust: 'self_attested',
      label: 'intake',
      dataHome: fixture.dir,
    });
    enableSourceFromDashboard(fixture.db, source.id);
    const first = await ingestBytes(fixture.db, fixture.store, {
      source_id: source.id,
      filename: 'about.txt',
      bytes: Buffer.from('The first version of the text.', 'utf8'),
    });
    expect(first.files_imported).toBe(1);

    const report = await ingestBytes(racingDriver(), fixture.store, {
      source_id: source.id,
      filename: 'about.txt',
      bytes: Buffer.from('A second, different version of the text.', 'utf8'),
    });

    // Superseding a predecessor that someone else already superseded would
    // leave two rows claiming to be the active artifact for one path, and
    // every later read would pick one of them arbitrarily.
    expect(report.files_imported).toBe(0);
    expect(report.rejects[0]?.reason).toMatch(/superseded concurrently|re-run the import/i);

    // And the ledger still has exactly one active artifact for that path.
    expect(
      fixture.db.all(
        'SELECT id FROM artifacts WHERE source_id = ? AND source_relpath = ? AND superseded_by IS NULL',
        source.id,
        'about.txt',
      ),
    ).toHaveLength(1);
  }, 60_000);
});
