import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSettingOrDefault,
  listBackups,
  readinessReport,
  resolveBackupDir,
  setSetting,
  validateBackupLabel,
  verifyBackup,
  verifyManagedBackup,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The edges of the domain services: the validation that decides what a setting
// may hold, the readiness checks a first run depends on, and the backup label
// and path rules. None of these are exotic — they are the rules that keep a
// wrong value, an unwritable home or a traversing name from getting through.

const fixtures: Fixture[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS reclaims it */
    }
  }
});

function fx(label = 'domain-edges'): Fixture {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  return fixture;
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `linkedin-mcp-${prefix}-`));
  dirs.push(dir);
  return dir;
}

describe('setting validation', () => {
  it('refuses a key it does not know, and names the ones it does', () => {
    const { db } = fx();
    expect(() => setSetting(db, 'not.a.setting' as never, 1, { confirm: true })).toThrow(
      /unknown setting/i,
    );
    expect(() => setSetting(db, 'not.a.setting' as never, 1, { confirm: true })).toThrow(
      /field_limits/,
    );
  });

  it('refuses any change that is not explicitly confirmed', () => {
    const { db } = fx();

    // These settings change how the importer and the validator behave, so the
    // confirmation is not ceremony: an unconfirmed call must not land, and the
    // gate runs before validation so a bad value is refused for that reason
    // first.
    expect(() => setSetting(db, 'importer.max_file_mb', 64)).toThrow(/confirm=true/);
    expect(getSettingOrDefault(db, 'importer.max_file_mb', 50)).toBe(50);
  });

  it('bounds the importer file ceiling to a sane integer range', () => {
    const { db } = fx();

    for (const bad of [0, -1, 1025, 1.5, '50', null]) {
      expect(() =>
        setSetting(db, 'importer.max_file_mb', bad as never, { confirm: true }),
      ).toThrow();
    }
    setSetting(db, 'importer.max_file_mb', 64, { confirm: true });
    expect(getSettingOrDefault(db, 'importer.max_file_mb', 50)).toBe(64);
  });

  it('accepts only safe basenames in the PII skiplist', () => {
    const { db } = fx();

    // Each of these would let a skiplist entry escape the archive it describes,
    // or name something that is not a file at all.
    for (const bad of [
      ['../secrets'],
      ['dir/file.csv'],
      ['dir\\file.csv'],
      ['.'],
      ['..'],
      [''],
      ['x'.repeat(256)],
      ['a\0b'],
      'Connections.csv',
      Array.from({ length: 101 }, (_, i) => `f${i}.csv`),
    ]) {
      expect(
        () => setSetting(db, 'importer.pii_skiplist', bad as never, { confirm: true }),
        `${JSON.stringify(bad).slice(0, 40)} should be refused`,
      ).toThrow();
    }

    setSetting(db, 'importer.pii_skiplist', ['Connections.csv', 'Messages.csv'], {
      confirm: true,
    });
    expect(getSettingOrDefault(db, 'importer.pii_skiplist', [])).toEqual([
      'Connections.csv',
      'Messages.csv',
    ]);
  });

  it('accepts only known LinkedIn fields, with integer limits', () => {
    const { db } = fx();

    expect(() => setSetting(db, 'field_limits', [] as never, { confirm: true })).toThrow(
      /expected an object/i,
    );
    expect(() => setSetting(db, 'field_limits', null as never, { confirm: true })).toThrow(
      /expected an object/i,
    );
    expect(() =>
      setSetting(db, 'field_limits', { not_a_field: 100 } as never, { confirm: true }),
    ).toThrow(/unknown field/i);
    expect(() =>
      setSetting(db, 'field_limits', { headline: 0 } as never, { confirm: true }),
    ).toThrow(/headline/);
    expect(() =>
      setSetting(db, 'field_limits', { headline: 100_001 } as never, { confirm: true }),
    ).toThrow(/headline/);

    setSetting(db, 'field_limits', { headline: 220 }, { confirm: true });
    expect(getSettingOrDefault(db, 'field_limits', {})['headline']).toBe(220);
  });

  it('accepts a Posts API version only as YYYYMM with a real month', () => {
    const { db } = fx();

    for (const bad of ['2026', '202613', '202600', '199901', 'latest', 202605]) {
      expect(() =>
        setSetting(db, 'linkedin.posts_api_version', bad as never, { confirm: true }),
      ).toThrow();
    }
    setSetting(db, 'linkedin.posts_api_version', '202605', { confirm: true });
    expect(getSettingOrDefault(db, 'linkedin.posts_api_version', '')).toBe('202605');
  });

  it('refuses a secret-shaped key outright, whatever its value', () => {
    const { db } = fx();

    // The settings table is readable through MCP. A key that looks like a
    // credential must never be storable there in the first place.
    for (const key of [
      'linkedin.access_token',
      'my_secret',
      'API_KEY',
      'bearer.thing',
      'auth.header',
      'db_password',
      'some.credential',
    ]) {
      expect(
        () => setSetting(db, key as never, 'x', { confirm: true }),
        `${key} should be refused`,
      ).toThrow();
    }
  });
});

describe('backup labels and paths', () => {
  it('accepts a plain label and refuses anything that could steer a path', () => {
    expect(validateBackupLabel('nightly')).toBe('nightly');
    expect(validateBackupLabel('before-upgrade_2')).toBe('before-upgrade_2');

    for (const bad of ['../escape', 'a/b', 'a\\b', '.', '..', '', 'x'.repeat(200), 'a b', 'a:b']) {
      expect(() => validateBackupLabel(bad), `${bad} should be refused`).toThrow();
    }
  });

  it('returns null for a backup name that is not in the managed root', () => {
    const home = tmp('backup-root');
    mkdirSync(join(home, 'backups'), { recursive: true });

    // Nothing here may resolve outside `<home>/backups`, whatever the name says.
    for (const name of ['..', '../..', 'a/b', 'nope']) {
      expect(resolveBackupDir(home, name), `${name} should not resolve`).toBeNull();
    }
  });

  it('reports an empty list when no backups have been taken', () => {
    const home = tmp('backup-empty');
    expect(listBackups(home)).toEqual([]);
  });

  it('refuses to verify a directory that is not a backup', () => {
    const home = tmp('backup-bogus');
    const directory = join(home, 'backups', 'not-a-backup');
    mkdirSync(directory, { recursive: true });

    const result = verifyBackup(directory);
    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('refuses to verify a managed backup that does not exist', () => {
    const home = tmp('backup-missing');
    mkdirSync(join(home, 'backups'), { recursive: true });
    expect(() => verifyManagedBackup(home, 'never-taken')).toThrow();
  });

  it('reports a backup whose contents were altered after it was written', () => {
    const home = tmp('backup-tampered');
    const directory = join(home, 'backups', 'tampered');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'backup-manifest.json'),
      JSON.stringify({
        format_version: 1,
        entries: [{ path: 'linkedin.sqlite3', sha256: 'f'.repeat(64), bytes: 36 }],
      }),
      'utf8',
    );
    writeFileSync(join(directory, 'linkedin.sqlite3'), 'not the bytes the manifest describes');

    // A backup is only a safety net if its contents still match what was
    // recorded; a hash mismatch has to be reported, not shrugged off.
    const result = verifyBackup(directory);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/linkedin\.sqlite3/);
  });
});

describe('the readiness report', () => {
  it('reports every check a first run depends on', () => {
    const fixture = fx('readiness-ok');
    seedHealthy(fixture);

    const report = readinessReport(fixture.db, { home: fixture.dir });
    const ids = report.checks.map((c) => c.id);

    for (const id of ['data_home', 'schema', 'linkedin']) {
      expect(ids, `${id} should be reported`).toContain(id);
    }
    // Every check carries a remediation whenever it is not ok, because a check
    // that only says "no" leaves the member with nowhere to go.
    for (const check of report.checks) {
      if (check.status !== 'ok') expect(check.remediation).toBeTruthy();
    }
  });

  it('says the schema is fine once migrations have run', () => {
    const fixture = fx('readiness-schema');
    const report = readinessReport(fixture.db, { home: fixture.dir });

    const schema = report.checks.find((c) => c.id === 'schema');
    expect(schema?.status).toBe('ok');
    expect(schema?.detail).toMatch(/\d+ migrations applied/);
  });

  it('reports a missing dashboard bundle as something to fix, and names the command', () => {
    const fixture = fx('readiness-nobundle');
    const clientDir = tmp('client-empty');

    const report = readinessReport(fixture.db, { home: fixture.dir, clientDir });
    const dashboard = report.checks.find((c) => c.id === 'dashboard_build');

    expect(dashboard?.status).toBe('action_needed');
    expect(dashboard?.remediation).toMatch(/npm run build/);
  });

  it('reports a built dashboard bundle as ready', () => {
    const fixture = fx('readiness-bundle');
    const clientDir = tmp('client-built');
    writeFileSync(join(clientDir, 'app.js'), '// built', 'utf8');

    const report = readinessReport(fixture.db, { home: fixture.dir, clientDir });
    expect(report.checks.find((c) => c.id === 'dashboard_build')?.status).toBe('ok');
  });

  it('skips the dashboard check entirely when the surface has no bundle to check', () => {
    const fixture = fx('readiness-nocheck');
    const report = readinessReport(fixture.db, { home: fixture.dir });

    // The MCP server has no browser bundle. Reporting a missing one there would
    // be an error the member cannot act on and does not have.
    const dashboard = report.checks.find((c) => c.id === 'dashboard_build');
    expect(dashboard?.status).not.toBe('action_needed');
  });

  it('treats an unconnected LinkedIn account as unavailable, not as a fault', () => {
    const fixture = fx('readiness-linkedin');
    const linkedin = readinessReport(fixture.db, { home: fixture.dir }).checks.find(
      (c) => c.id === 'linkedin',
    );

    // Without a developer app there is nothing to fix, and outside the EEA or
    // Switzerland the read lane cannot be provisioned at all. Calling that
    // "action needed" would send the member after something unreachable.
    expect(linkedin?.status).not.toBe('action_needed');
  });

  it('reports an unwritable home rather than failing later at the first write', () => {
    const fixture = fx('readiness-home');
    const report = readinessReport(fixture.db, {
      home: join(fixture.dir, 'no', 'such', 'place'),
    });

    const home = report.checks.find((c) => c.id === 'data_home');
    expect(home?.status).toBe('action_needed');
    expect(home?.remediation).toMatch(/LINKEDIN_MCP_HOME/);
  });
});
