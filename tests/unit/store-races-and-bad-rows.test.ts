import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two processes writing the same bytes, and rows written by something else.
//
// The MCP server and the dashboard run against one home, so every write here is
// a write two processes might be making at the same moment. The content-
// addressed store leans on that being harmless — identical bytes, identical
// name — but the rename itself can still lose, and losing has to mean "someone
// else already put it there", not "the import failed".

const LOSE_RENAME = 'LOSE-RENAME';
const VANISH_STAT = 'VANISH-STAT';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
  return {
    ...actual,
    renameSync: (from: unknown, to: unknown) => {
      // The loser of a rename race on Windows: the destination is already
      // there, written by the other process a moment ago.
      if (String(to).includes(LOSE_RENAME) || renameShouldFail) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), {
          code: 'EPERM',
        });
      }
      return (actual.renameSync as (...a: unknown[]) => unknown)(from, to);
    },
    lstatSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(VANISH_STAT)) throw enoent(String(path));
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

let renameShouldFail = false;

const { ArtifactStore } = await import('@linkedin-mcp/db');
const { listBackups } = await import('@linkedin-mcp/domain');

let home: string;

beforeEach(() => {
  renameShouldFail = false;
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-race-'));
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('losing a rename race in the artifact store', () => {
  it('adopts the bytes the other process wrote, because they are the same bytes', () => {
    const store = new ArtifactStore(join(home, 'artifacts'));
    const bytes = Buffer.from('The project ships a hash-chained audit log.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // The other process got there first: same content, same name, already on
    // disk and marked read-only.
    const path = store.pathFor(sha256);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
    renameShouldFail = true;

    const result = store.put(bytes);

    // Content addressing is what makes this safe: whoever won wrote exactly
    // what we were about to write, so the loser reports a duplicate rather
    // than an error the member would have to understand.
    expect(result.existed).toBe(true);
    expect(result.sha256).toBe(sha256);
    expect(Buffer.from(store.read(sha256)).toString('utf8')).toContain('hash-chained');
  });

  it('reports a rename that failed for any other reason', () => {
    const store = new ArtifactStore(join(home, 'artifacts'));
    renameShouldFail = true;

    // Nothing is on disk under that name, so the rename did not lose a race —
    // it failed. Swallowing it would report an import that stored nothing as a
    // success, and the claims built on it would cite bytes that are not there.
    expect(() => store.put(Buffer.from('bytes that never land'))).toThrow(/EPERM/);
  });
});

describe('listing backups over a directory that is moving', () => {
  it('skips an entry it cannot stat and lists the rest', () => {
    const backups = join(home, 'backups');
    const good = join(backups, '2026-08-19T10-00-00-000Z');
    mkdirSync(good, { recursive: true });
    writeFileSync(
      join(good, 'backup-manifest.json'),
      JSON.stringify({
        format_version: 1,
        created_at: '2026-08-19T10:00:00.000Z',
        entries: [{ path: 'linkedin.sqlite3', bytes: 4, sha256: 'a'.repeat(64) }],
      }),
      'utf8',
    );
    mkdirSync(join(backups, `${VANISH_STAT}-2026`), { recursive: true });

    const listed = listBackups(home);

    // The listing and the stat are two syscalls, and a backup directory is
    // exactly where an antivirus scanner or a sync client is busy. One entry
    // going away must not hide the backups that are still there.
    expect(listed.map((b) => b.name)).toEqual(['2026-08-19T10-00-00-000Z']);
  });

  it('lists a backup whose manifest cannot be read as unusable rather than hiding it', () => {
    const backups = join(home, 'backups');
    const broken = join(backups, '2026-08-18T09-00-00-000Z');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'backup-manifest.json'), '{not json', 'utf8');

    const listed = listBackups(home);

    // Hidden, a member would believe they have one fewer backup than they do
    // and might delete the wrong thing. Shown with nothing in it, they can see
    // it is not a safety net.
    expect(listed).toHaveLength(1);
    expect(listed[0]?.entries).toBe(0);
    expect(listed[0]?.created_at).toBe('');
  });

  it('answers with nothing at all when no backup has ever been made', () => {
    expect(listBackups(home)).toEqual([]);
  });

  it('ignores a file sitting in the backups directory', () => {
    mkdirSync(join(home, 'backups'), { recursive: true });
    writeFileSync(join(home, 'backups', 'notes.txt'), 'not a backup', 'utf8');

    expect(listBackups(home)).toEqual([]);
  });
});
