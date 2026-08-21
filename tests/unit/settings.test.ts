import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { getSetting, getSettingOrDefault, setSetting } from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-set-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

describe('settings service', () => {
  it('round-trips allowlisted keys', () => {
    setSetting(db, 'dashboard.port', 4780, { confirm: true });
    expect(getSetting(db, 'dashboard.port')).toBe(4780);
    setSetting(db, 'dashboard.port', 4781, { confirm: true });
    expect(getSetting(db, 'dashboard.port')).toBe(4781);
  });

  it('requires explicit confirmation for runtime-setting changes', () => {
    expect(codeOf(() => setSetting(db, 'dashboard.port', 4780))).toBe('INVALID_INPUT');
    expect(getSetting(db, 'dashboard.port')).toBeUndefined();
  });

  it('rejects values that could disable safety guards', () => {
    expect(
      codeOf(() => setSetting(db, 'importer.max_file_mb', 'not-a-number', { confirm: true })),
    ).toBe('INVALID_INPUT');
    expect(codeOf(() => setSetting(db, 'dashboard.port', 80, { confirm: true }))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(() => setSetting(db, 'importer.pii_skiplist', null, { confirm: true }))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(() => setSetting(db, 'field_limits', { headline: -1 }, { confirm: true }))).toBe(
      'INVALID_INPUT',
    );
    expect(
      codeOf(() => setSetting(db, 'linkedin.posts_api_version', '202613', { confirm: true })),
    ).toBe('INVALID_INPUT');
  });

  it('uses a safe default when a legacy stored row is malformed', () => {
    db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      'importer.max_file_mb',
      JSON.stringify('not-a-number'),
      new Date().toISOString(),
    );
    expect(() => getSetting(db, 'importer.max_file_mb')).toThrowError(DomainError);
    expect(getSettingOrDefault(db, 'importer.max_file_mb', 50)).toBe(50);
  });

  it('refuses secret-shaped keys with SECRET_VIA_MCP_FORBIDDEN', () => {
    expect(codeOf(() => setSetting(db, 'linkedin.access_token', 'x'))).toBe(
      'SECRET_VIA_MCP_FORBIDDEN',
    );
    expect(codeOf(() => setSetting(db, 'my_api_key', 'x'))).toBe('SECRET_VIA_MCP_FORBIDDEN');
    expect(codeOf(() => setSetting(db, 'client_password', 'x'))).toBe('SECRET_VIA_MCP_FORBIDDEN');
  });

  it('refuses unknown keys with INVALID_INPUT naming the allowlist', () => {
    expect(codeOf(() => setSetting(db, 'not.a.setting', 1))).toBe('INVALID_INPUT');
  });
});
