import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBackups, verifyBackup } from '@linkedin-mcp/domain';

// A backup directory with links in it.
//
// A backup is the only thing standing between a member and a purge that cannot
// be undone, so "verified" has to mean the bytes on disk are the bytes that
// were written. A link is how that stops being true without anything looking
// wrong: the manifest can point at a file somewhere else, or a directory inside
// the backup can be a doorway out of it. Both are refused by name.
//
// Creating links needs Developer Mode or elevation on Windows, so this probes
// for the capability rather than assuming it.

function linksSupported(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'linkedin-mcp-linkprobe-'));
  try {
    mkdirSync(join(probe, 'target'));
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS reclaims it */
    }
  }
}

const HAS_LINKS = linksSupported();

let home: string;
let backup: string;
let outside: string;

const hashOf = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-blink-'));
  outside = mkdtempSync(join(tmpdir(), 'linkedin-mcp-outside-'));
  backup = join(home, 'backups', '2026-08-19T10-00-00-000Z');
  mkdirSync(backup, { recursive: true });
});

afterEach(() => {
  for (const dir of [home, outside]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS reclaims it */
    }
  }
});

function writeManifest(entries: Array<{ path: string; bytes: number; sha256: string }>): void {
  writeFileSync(
    join(backup, 'backup-manifest.json'),
    JSON.stringify({ format_version: 1, created_at: '2026-08-19T10:00:00.000Z', entries }),
    'utf8',
  );
}

describe('a manifest that is a link to somewhere else', () => {
  it.runIf(HAS_LINKS)('is refused rather than followed', () => {
    const real = join(outside, 'backup-manifest.json');
    writeFileSync(real, JSON.stringify({ format_version: 1, created_at: '', entries: [] }), 'utf8');
    symlinkSync(real, join(backup, 'backup-manifest.json'), 'file');

    const result = verifyBackup(backup);

    // The manifest is the list of what must match. Reading it from outside the
    // backup means verifying one thing and restoring another.
    expect(result.valid).toBe(false);
    expect(result.problems).toContain('backup-manifest.json must not be a link');
  });

  it.runIf(HAS_LINKS)('is not listed as a backup either', () => {
    const real = join(outside, 'backup-manifest.json');
    writeFileSync(real, '{}', 'utf8');
    symlinkSync(real, join(backup, 'backup-manifest.json'), 'file');

    expect(listBackups(home)).toEqual([]);
  });
});

describe('an entry that resolves outside the backup', () => {
  it.runIf(HAS_LINKS)('is refused, even though its path looks ordinary', () => {
    // The path in the manifest is a plain relative name with no traversal in
    // it. What escapes is the directory it goes through.
    const bytes = 'the database from somewhere else entirely';
    writeFileSync(join(outside, 'linkedin.sqlite3'), bytes, 'utf8');
    symlinkSync(outside, join(backup, 'elsewhere'), 'junction');
    writeManifest([
      { path: 'linkedin.sqlite3', bytes: bytes.length, sha256: hashOf(bytes) },
      { path: 'elsewhere/linkedin.sqlite3', bytes: bytes.length, sha256: hashOf(bytes) },
    ]);
    writeFileSync(join(backup, 'linkedin.sqlite3'), bytes, 'utf8');

    const result = verifyBackup(backup);

    // A verification that walked out of the directory would report a backup as
    // intact on the strength of a file the purge is about to delete.
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/escapes backup directory/i);
  });
});

describe('a backup directory that is itself a link', () => {
  it.runIf(HAS_LINKS)('is not listed', () => {
    const real = join(outside, 'pretend-backup');
    mkdirSync(real, { recursive: true });
    writeFileSync(
      join(real, 'backup-manifest.json'),
      JSON.stringify({ format_version: 1, created_at: '', entries: [] }),
      'utf8',
    );
    symlinkSync(real, join(home, 'backups', 'linked'), 'junction');

    // Backups are addressed by name inside the managed root. A directory that
    // is really somewhere else is outside what a purge and a verify agree on.
    expect(listBackups(home).map((b) => b.name)).not.toContain('linked');
  });
});

describe('the ordinary case, for contrast', () => {
  it('verifies a real backup with matching bytes', () => {
    const bytes = 'the actual database bytes';
    writeFileSync(join(backup, 'linkedin.sqlite3'), bytes, 'utf8');
    writeManifest([{ path: 'linkedin.sqlite3', bytes: bytes.length, sha256: hashOf(bytes) }]);

    const result = verifyBackup(backup);

    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('reports a hash mismatch against the entry that moved', () => {
    const bytes = 'the actual database bytes';
    writeFileSync(join(backup, 'linkedin.sqlite3'), 'something else entirely', 'utf8');
    writeManifest([{ path: 'linkedin.sqlite3', bytes: bytes.length, sha256: hashOf(bytes) }]);

    const result = verifyBackup(backup);

    // Named, because a member with several backups needs to know which file in
    // which one is the problem.
    expect(result.problems.join(' ')).toMatch(/linkedin\.sqlite3/);
    expect(result.valid).toBe(false);
  });
});
