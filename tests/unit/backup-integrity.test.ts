import { Buffer } from 'node:buffer';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listBackups,
  resolveBackupDir,
  runBackup,
  verifyBackup,
  verifyManagedBackup,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// What the backup code does when the directory it is looking at is not what it
// expects.
//
// A backup is the only thing standing between a member and a full purge, so
// "this is not a usable backup" has to be a conclusion the code reaches out
// loud. Everything here builds the bad state on disk and checks it is named
// rather than skipped, because a skipped one is indistinguishable from a
// working one in a list.

let fixture: Fixture;
let root: string;

beforeEach(() => {
  fixture = createFixture('backup-integrity');
  seedHealthy(fixture);
  root = join(fixture.dir, 'backups');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fixture.close();
});

function bogus(name: string, manifest: unknown, files: Record<string, string> = {}): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(
      join(directory, 'backup-manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      'utf8',
    );
  }
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(join(directory, file), body, 'utf8');
  }
  return directory;
}

describe('a real backup', () => {
  it('verifies, and says how many entries it checked', async () => {
    const created = await runBackup(fixture.db, fixture.dir, { actor: 'dashboard' });

    const result = verifyBackup(created.directory);

    expect(result.valid).toBe(true);
    expect(result.checked).toBe(created.entries);
    expect(result.problems).toEqual([]);
  });

  it('appears in the listing with its size and entry count', async () => {
    const created = await runBackup(fixture.db, fixture.dir, { label: 'nightly' });

    const listing = listBackups(fixture.dir).find((b) => b.name === created.name);
    expect(listing?.entries).toBe(created.entries);
    expect(listing?.total_bytes).toBe(created.total_bytes);
    expect(listing?.created_at).toBeTruthy();
  });

  it('is addressable by name and by nothing else', async () => {
    const created = await runBackup(fixture.db, fixture.dir);

    expect(resolveBackupDir(fixture.dir, created.name)).toBeTruthy();
    // Anything that could steer the resolution somewhere else answers null.
    for (const name of ['..', '../..', 'a/b', 'a\\b', '', '.']) {
      expect(resolveBackupDir(fixture.dir, name), name).toBeNull();
    }
  });

  it('excludes the secrets folder, so a backup carries no credential', async () => {
    const created = await runBackup(fixture.db, fixture.dir);

    // DPAPI material is machine-bound and useless elsewhere; leaving it out is
    // what makes every backup safe to copy.
    const manifest = JSON.stringify(created);
    expect(manifest).not.toMatch(/secrets/);
  });
});

describe('a directory that is not a backup', () => {
  it('is reported when its manifest is missing', () => {
    const directory = bogus('no-manifest', undefined);
    const result = verifyBackup(directory);

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/manifest.*missing/i);
  });

  it('is reported when its manifest is not JSON', () => {
    const directory = bogus('bad-json', '{ this is not json');
    const result = verifyBackup(directory);

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/unreadable/i);
  });

  it('is reported when its format version is one this build does not know', () => {
    const directory = bogus('future', { format_version: 99, entries: [] });
    const result = verifyBackup(directory);

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/format_version/i);
  });

  it('is reported when its manifest lists nothing', () => {
    const directory = bogus('empty', { format_version: 1, entries: [] });
    const result = verifyBackup(directory);

    // An empty backup is not a backup, however healthy it looks.
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/non-empty/i);
  });

  it('is reported when an entry is malformed', () => {
    const directory = bogus('malformed', {
      format_version: 1,
      entries: [{ path: 'x', bytes: -1, sha256: 'not-a-hash' }],
    });
    const result = verifyBackup(directory);

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/malformed/i);
  });

  it('is reported when an entry names a path outside the backup', () => {
    for (const path of ['../escape', '/etc/passwd', 'C:\\Windows\\x', 'a\\b', './x', 'a//b']) {
      const directory = bogus(`escape-${Buffer.from(path).toString('hex')}`, {
        format_version: 1,
        entries: [{ path, bytes: 1, sha256: 'a'.repeat(64) }],
      });

      // A manifest is untrusted input: it arrives from disk and could have been
      // written by anything. A path in it must never be able to reach outside.
      const result = verifyBackup(directory);
      expect(result.valid, path).toBe(false);
      expect(result.problems.join(' '), path).toMatch(/unsafe path/i);
    }
  });

  it('is reported when the file an entry names is missing', () => {
    const directory = bogus('missing-file', {
      format_version: 1,
      entries: [{ path: 'linkedin.sqlite3', bytes: 4, sha256: 'a'.repeat(64) }],
    });
    const result = verifyBackup(directory);

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/linkedin\.sqlite3/);
  });

  it('is reported when the bytes no longer match the hash', () => {
    const directory = bogus(
      'tampered',
      {
        format_version: 1,
        entries: [{ path: 'linkedin.sqlite3', bytes: 4, sha256: 'a'.repeat(64) }],
      },
      { 'linkedin.sqlite3': 'nope' },
    );
    const result = verifyBackup(directory);

    // This is the whole point of the manifest: a backup that has rotted is
    // worse than none, because the member believes they are covered.
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/linkedin\.sqlite3/);
  });

  it('is reported when the directory does not exist at all', () => {
    const result = verifyBackup(join(root, 'never-existed'));

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/missing or unreadable/i);
  });
});

describe('links where a backup should be', () => {
  it('refuses a backup directory that is a link', () => {
    const real = join(fixture.dir, 'elsewhere');
    mkdirSync(real, { recursive: true });
    try {
      symlinkSync(real, join(root, 'linked'), 'junction');
    } catch {
      return; // creating a junction can need privileges this run lacks
    }

    // Following one would let a manifest outside the managed root decide
    // whether the member is covered.
    const result = verifyBackup(join(root, 'linked'));
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/link/i);
  });

  it('leaves a linked directory out of the listing entirely', () => {
    const real = join(fixture.dir, 'elsewhere2');
    mkdirSync(real, { recursive: true });
    writeFileSync(
      join(real, 'backup-manifest.json'),
      JSON.stringify({ format_version: 1, created_at: '2026-01-01T00:00:00.000Z', entries: [] }),
      'utf8',
    );
    try {
      symlinkSync(real, join(root, 'linked2'), 'junction');
    } catch {
      return;
    }

    expect(listBackups(fixture.dir).some((b) => b.name === 'linked2')).toBe(false);
  });
});

describe('the listing', () => {
  it('lists an unreadable backup as unusable rather than hiding it', () => {
    bogus('corrupt', '{ broken');

    // Silently skipping it would leave the member counting a backup that is
    // not there. It is listed with nothing in it instead.
    const listing = listBackups(fixture.dir).find((b) => b.name === 'corrupt');
    expect(listing).toBeTruthy();
    expect(listing?.entries).toBe(0);
    expect(listing?.total_bytes).toBe(0);
  });

  it('ignores a stray file sitting in the backups folder', () => {
    writeFileSync(join(root, 'notes.txt'), 'not a backup', 'utf8');
    expect(listBackups(fixture.dir).some((b) => b.name === 'notes.txt')).toBe(false);
  });

  it('puts the newest first, so the most useful one is at the top', async () => {
    await runBackup(fixture.db, fixture.dir, { label: 'first' });
    await runBackup(fixture.db, fixture.dir, { label: 'second' });

    const names = listBackups(fixture.dir).map((b) => b.name);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect([...names].sort((a, b) => b.localeCompare(a))).toEqual(names);
  });
});

describe('verifying by name', () => {
  it('refuses a name that resolves to nothing', () => {
    expect(() => verifyManagedBackup(fixture.dir, 'never-taken')).toThrow();
    expect(() => verifyManagedBackup(fixture.dir, '../..')).toThrow();
  });

  it('verifies one that exists', async () => {
    const created = await runBackup(fixture.db, fixture.dir);
    expect(verifyManagedBackup(fixture.dir, created.name).valid).toBe(true);
  });
});
