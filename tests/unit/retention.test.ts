import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { runRetentionSweep } from '@linkedin-mcp/domain';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-ret-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function insertHandle(handle: string, expiresAt: string, consumedAt: string | null) {
  db.run(
    "INSERT INTO state_handles (handle, purpose, payload_json, expires_at, consumed_at) VALUES (?, 'cursor', '{}', ?, ?)",
    handle,
    expiresAt,
    consumedAt,
  );
}

describe('retention sweep', () => {
  it('removes expired and consumed handles, keeps live ones', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    insertHandle('h_expired', '2026-08-08T11:59:59Z', null);
    insertHandle('h_consumed', '2026-08-09T00:00:00Z', '2026-08-08T10:00:00Z');
    insertHandle('h_live', '2026-08-09T00:00:00Z', null);

    const report = runRetentionSweep(db, now);
    expect(report.state_handles_removed).toBe(2);

    const remaining = db.all('SELECT handle FROM state_handles');
    expect(remaining.map((r) => r['handle'])).toEqual(['h_live']);
  });

  it('is a no-op on an empty database', () => {
    expect(runRetentionSweep(db).state_handles_removed).toBe(0);
  });
});
