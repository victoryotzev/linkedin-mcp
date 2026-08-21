import { Buffer } from 'node:buffer';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackups, verifyBackup } from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Every way a single manifest entry can be wrong.
//
// The manifest is untrusted input in the ordinary sense: it arrives from disk
// and could have been written by anything, including an older build or a
// half-finished copy. Each entry is checked on its own and reported by name,
// because "the backup is invalid" tells a member nothing about whether the
// file they care about survived.

let fixture: Fixture;
let root: string;

beforeEach(() => {
  fixture = createFixture('backup-entries');
  seedHealthy(fixture);
  root = join(fixture.dir, 'backups');
  mkdirSync(root, { recursive: true });
});

afterEach(() => fixture.close());

const sha = (body: string) => createHash('sha256').update(Buffer.from(body)).digest('hex');

function backupWith(name: string, entries: unknown[], files: Record<string, string> = {}): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'backup-manifest.json'),
    JSON.stringify({
      format_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      entries,
    }),
    'utf8',
  );
  for (const [file, body] of Object.entries(files)) {
    const full = join(directory, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return directory;
}

const problems = (directory: string) => verifyBackup(directory).problems.join(' | ');

describe('an entry that names something it should not', () => {
  it('refuses anything under secrets/, so a backup never carries a credential', () => {
    const body = 'DPAPI-wrapped bytes';
    const directory = backupWith(
      'has-secrets',
      [{ path: 'secrets/master.key.dpapi', bytes: body.length, sha256: sha(body) }],
      { 'secrets/master.key.dpapi': body },
    );

    // Backups are meant to be safe to copy. A manifest that lists secret
    // material is not a backup this product wrote, and saying so is the point.
    expect(problems(directory)).toMatch(/secret material/i);
    expect(verifyBackup(directory).valid).toBe(false);
  });

  it('refuses the same path listed twice', () => {
    const body = 'x';
    const entry = { path: 'data.txt', bytes: 1, sha256: sha(body) };
    const directory = backupWith('duplicate', [entry, entry], { 'data.txt': body });

    // A duplicate would be counted twice in the size a member is shown, and it
    // suggests the manifest was assembled rather than written.
    expect(problems(directory)).toMatch(/duplicate/i);
  });
});

describe('an entry whose file is wrong', () => {
  it('reports a size that does not match', () => {
    const body = 'four';
    const directory = backupWith(
      'wrong-size',
      [{ path: 'data.txt', bytes: 99, sha256: sha(body) }],
      { 'data.txt': body },
    );

    expect(problems(directory)).toMatch(/size mismatch: data\.txt/);
  });

  it('reports a hash that does not match', () => {
    const directory = backupWith(
      'wrong-hash',
      [{ path: 'data.txt', bytes: 4, sha256: 'a'.repeat(64) }],
      { 'data.txt': 'four' },
    );

    expect(problems(directory)).toMatch(/hash mismatch: data\.txt/);
  });

  it('reports an entry that names a directory rather than a file', () => {
    const directory = backupWith('is-a-dir', [
      { path: 'nested', bytes: 0, sha256: 'a'.repeat(64) },
    ]);
    mkdirSync(join(directory, 'nested'), { recursive: true });

    expect(problems(directory)).toMatch(/not a regular file: nested/);
  });

  it('reports an entry that is a link out of the backup', () => {
    const outside = join(fixture.dir, 'outside.txt');
    writeFileSync(outside, 'not part of the backup', 'utf8');
    const directory = backupWith('linked-entry', [
      { path: 'data.txt', bytes: 4, sha256: sha('four') },
    ]);
    try {
      symlinkSync(outside, join(directory, 'data.txt'), 'file');
    } catch {
      return; // creating a link can need privileges this run lacks
    }

    // Following it would let a file outside the backup stand in for one inside
    // it, which is how a backup passes verification while holding nothing.
    expect(problems(directory)).toMatch(/not a regular file|escapes backup directory/i);
  });

  it('verifies a manifest whose entries all match', () => {
    const db = 'pretend database bytes';
    const body = 'exactly these bytes';
    const directory = backupWith(
      'good',
      [
        { path: 'linkedin.sqlite3', bytes: db.length, sha256: sha(db) },
        { path: 'data.txt', bytes: body.length, sha256: sha(body) },
      ],
      { 'linkedin.sqlite3': db, 'data.txt': body },
    );

    const result = verifyBackup(directory);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });

  it('refuses a manifest with no database in it, however well-formed', () => {
    const body = 'exactly these bytes';
    const directory = backupWith(
      'no-database',
      [{ path: 'data.txt', bytes: body.length, sha256: sha(body) }],
      { 'data.txt': body },
    );

    // Every entry checks out and it is still not a backup: without the database
    // there is nothing to restore, and a member relying on it would find that
    // out at the worst possible moment.
    const result = verifyBackup(directory);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/must contain linkedin\.sqlite3/i);
  });

  it('checks every entry rather than stopping at the first bad one', () => {
    const directory = backupWith(
      'several-problems',
      [
        { path: 'missing.txt', bytes: 1, sha256: 'a'.repeat(64) },
        { path: 'wrong.txt', bytes: 99, sha256: sha('short') },
        { path: 'secrets/leak', bytes: 1, sha256: 'a'.repeat(64) },
      ],
      { 'wrong.txt': 'short' },
    );

    // A member fixing one problem should not have to re-run to discover the
    // next two.
    const reported = problems(directory);
    expect(reported).toMatch(/missing\.txt/);
    expect(reported).toMatch(/wrong\.txt/);
    expect(reported).toMatch(/secret material/i);
  });
});

describe('the listing beside it', () => {
  it('reports the total size across entries', () => {
    backupWith('sized', [
      { path: 'a.txt', bytes: 3, sha256: sha('aaa') },
      { path: 'b.txt', bytes: 4, sha256: sha('bbbb') },
    ]);

    const listing = listBackups(fixture.dir).find((b) => b.name === 'sized');
    expect(listing?.entries).toBe(2);
    expect(listing?.total_bytes).toBe(7);
  });
});
