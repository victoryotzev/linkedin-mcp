import { Buffer } from 'node:buffer';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  exportBundle,
  importObservations,
  proposeClaim,
  purgeEverything,
  resolveBackupDir,
  runBackup,
  verifyAuditChain,
  verifyBackup,
  verifyManagedBackup,
  verifyClaim,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let home: string;
let db: SqliteDriver;
let store: ArtifactStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-bkp-'));
  db = openDatabase(join(home, 'data', 'linkedin.sqlite3')).db;
  migrate(db);
  store = new ArtifactStore(join(home, 'artifacts'));
  store.put(Buffer.from('artifact bytes worth preserving'));
  const { artifactId } = seedSourceAndArtifact(db);
  const claim = proposeClaim(db, {
    statement: 'A verified statement that must survive a backup and restore.',
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'manual',
  });
  verifyClaim(db, { claim_id: claim.id, confirm: true });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by a purge test
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('backup and restore', () => {
  it('produces a self-verifying archive containing the database and artifacts', async () => {
    const result = await runBackup(db, home, { label: 'test' });
    expect(result.entries).toBeGreaterThanOrEqual(2);
    const verification = verifyBackup(result.directory);
    expect(verification.valid).toBe(true);
    expect(verification.problems).toEqual([]);
    expect(existsSync(join(result.directory, 'linkedin.sqlite3'))).toBe(true);
  });

  it('rejects traversal and reserved backup labels before creating a directory', async () => {
    const escaped = join(home, '..', 'escaped-backup');
    await expect(runBackup(db, home, { label: '..\\..\\escaped-backup' })).rejects.toThrowError(
      DomainError,
    );
    await expect(runBackup(db, home, { label: 'CON' })).rejects.toThrowError(DomainError);
    expect(existsSync(escaped)).toBe(false);
  });

  it('only resolves real managed backup directories, never traversal or junctions', async () => {
    const result = await runBackup(db, home, { label: 'managed' });
    expect(resolveBackupDir(home, result.name)).toBe(result.directory);
    expect(resolveBackupDir(home, '..')).toBeNull();
    expect(resolveBackupDir(home, '..\\outside')).toBeNull();

    const outside = mkdtempSync(join(tmpdir(), 'linkedin-mcp-outside-backup-'));
    const junction = join(home, 'backups', 'junction-backup');
    try {
      writeFileSync(
        join(outside, 'backup-manifest.json'),
        JSON.stringify({
          format_version: 1,
          created_at: new Date().toISOString(),
          schema_version: 1,
          entries: [],
        }),
      );
      symlinkSync(outside, junction, 'junction');
      expect(resolveBackupDir(home, 'junction-backup')).toBeNull();
      expect(() => verifyManagedBackup(home, 'junction-backup')).toThrowError(DomainError);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('rejects empty and path-escaping manifests', () => {
    const directory = join(home, 'backups', 'fabricated');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'backup-manifest.json'),
      JSON.stringify({
        format_version: 1,
        created_at: new Date().toISOString(),
        schema_version: 1,
        entries: [],
      }),
    );
    expect(verifyBackup(directory)).toMatchObject({ valid: false, checked: 0 });

    writeFileSync(join(home, 'outside.txt'), 'outside');
    writeFileSync(
      join(directory, 'backup-manifest.json'),
      JSON.stringify({
        format_version: 1,
        created_at: new Date().toISOString(),
        schema_version: 1,
        entries: [{ path: '../outside.txt', bytes: 7, sha256: '0'.repeat(64) }],
      }),
    );
    const traversal = verifyBackup(directory);
    expect(traversal.valid).toBe(false);
    expect(traversal.problems.join(' ')).toContain('unsafe path');
    expect(traversal.problems.join(' ')).toContain('linkedin.sqlite3');
  });

  // This assertion used to be unfalsifiable twice over: runBackup only ever
  // walks home/artifacts, and the fixture never created a secrets/ directory,
  // so 'no entry starts with secrets/' was true of an empty set. A real
  // DPAPI-wrapped key now exists on disk for the backup to fail to exclude.
  it('never includes secret material', async () => {
    const secretsDir = join(home, 'secrets');
    mkdirSync(secretsDir, { recursive: true });
    const SENTINEL = 'WRAPPED-MASTER-KEY-SENTINEL-a1b2c3d4';
    writeFileSync(join(secretsDir, 'master.key.dpapi'), SENTINEL);

    const result = await runBackup(db, home);
    const manifest = JSON.parse(
      readFileSync(join(result.directory, 'backup-manifest.json'), 'utf8'),
    ) as {
      entries: Array<{ path: string }>;
    };
    expect(manifest.entries.every((e) => !e.path.startsWith('secrets/'))).toBe(true);

    // And the bytes are genuinely absent, not merely unlisted in the manifest.
    const copied = readdirSync(result.directory, { recursive: true }) as string[];
    expect(copied.some((p) => String(p).includes('secrets'))).toBe(false);
    for (const rel of copied) {
      const full = join(result.directory, String(rel));
      if (!statSync(full).isFile()) continue;
      expect(readFileSync(full, 'utf8')).not.toContain(SENTINEL);
    }
  });

  it('does not follow a junction out of the managed artifact store', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'linkedin-mcp-outside-artifact-'));
    const junction = join(home, 'artifacts', 'outside-junction');
    try {
      writeFileSync(join(outside, 'must-not-be-backed-up.txt'), 'external sentinel');
      symlinkSync(outside, junction, 'junction');
      const result = await runBackup(db, home);
      const manifest = JSON.parse(
        readFileSync(join(result.directory, 'backup-manifest.json'), 'utf8'),
      ) as { entries: Array<{ path: string }> };
      expect(manifest.entries.some((entry) => entry.path.includes('outside-junction'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('rejects a tampered archive', async () => {
    const result = await runBackup(db, home);
    const artifactEntry = JSON.parse(
      readFileSync(join(result.directory, 'backup-manifest.json'), 'utf8'),
    ).entries.find((e: { path: string }) => e.path.startsWith('artifacts/')) as { path: string };
    const target = join(result.directory, artifactEntry.path);
    chmodSync(target, 0o644);
    writeFileSync(target, 'tampered content');
    const verification = verifyBackup(result.directory);
    expect(verification.valid).toBe(false);
    expect(verification.problems.join(' ')).toContain('hash mismatch');
  });

  it('restores into a fresh home with the audit chain and claims intact', async () => {
    const result = await runBackup(db, home);
    db.close();

    const restored = mkdtempSync(join(tmpdir(), 'linkedin-mcp-restore-'));
    try {
      // A restore is a file move of a VERIFIED archive, then a normal open.
      expect(verifyBackup(result.directory).valid).toBe(true);
      const restoredDb = openDatabase(join(restored, 'data', 'linkedin.sqlite3')).db;
      restoredDb.close();
      rmSync(join(restored, 'data', 'linkedin.sqlite3'));
      writeFileSync(
        join(restored, 'data', 'linkedin.sqlite3'),
        readFileSync(join(result.directory, 'linkedin.sqlite3')),
      );
      const reopened = openDatabase(join(restored, 'data', 'linkedin.sqlite3')).db;
      try {
        expect(verifyAuditChain(reopened).valid).toBe(true);
        const claims = reopened.all("SELECT id FROM claims WHERE state = 'verified'");
        expect(claims).toHaveLength(1);
        expect(Number(reopened.get('PRAGMA user_version')?.['user_version'] ?? 0)).toBe(0);
        const integrity = reopened.get('PRAGMA integrity_check');
        expect(String(Object.values(integrity ?? {})[0])).toBe('ok');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(restored, { recursive: true, force: true, maxRetries: 3 });
      db = openDatabase(join(home, 'data', 'linkedin.sqlite3')).db;
    }
  });
});

describe('export bundle', () => {
  it('carries own data and excludes Marketing-sourced rows', () => {
    importObservations(db, [
      {
        subject_ref: 'urn:li:share:1',
        metric: 'impressions',
        value: 10,
        observed_at: '2026-08-01',
      },
    ]);
    importObservations(
      db,
      [
        {
          subject_ref: 'urn:li:share:2',
          metric: 'impressions',
          value: 20,
          observed_at: '2026-08-02',
        },
      ],
      { source: 'api' },
    );
    const bundle = exportBundle(db);
    expect(bundle.observations).toHaveLength(1);
    expect(bundle.claims.length).toBeGreaterThan(0);
    expect(bundle.note).toContain('restricted-use');
  });
});

describe('full purge', () => {
  it('requires the exact confirmation phrase', () => {
    expect(() => purgeEverything(home, 'yes')).toThrowError(DomainError);
    expect(existsSync(join(home, 'data'))).toBe(true);
  });

  it('removes every managed directory when confirmed', () => {
    db.close();
    const result = purgeEverything(home, 'DELETE ALL LOCAL DATA');
    expect(result.removed).toEqual(expect.arrayContaining(['data', 'artifacts']));
    expect(existsSync(join(home, 'data'))).toBe(false);
    expect(existsSync(join(home, 'artifacts'))).toBe(false);
    db = openDatabase(join(home, 'data', 'linkedin.sqlite3')).db;
  });
});
