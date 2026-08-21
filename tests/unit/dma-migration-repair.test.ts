import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';

// Migration 017 runs against databases that already hold real data, at every
// process start, with no down migration. Two of its three jobs are repairs of
// values that are already wrong on disk, and one of those repairs feeds the
// changelog fetch cursor — which governs a 28-day window that LinkedIn will
// never serve again. So the invariants asserted here are: the seeded cursor can
// only ever be too conservative, and nothing raw is lost or rewritten.

const WALL_CLOCK_WATERMARK = 1_786_528_800_000; // what the defect used to store
const OLDER_PROCESSED_AT = 1_786_527_100_000;
const NEWEST_PROCESSED_AT = 1_786_528_100_000;
const FAR_FUTURE = 32_503_680_000_000; // year 3000

let dir: string;
let db: SqliteDriver;

function seedLegacyEvent(payload: Record<string, unknown>, requestedSince: number): string {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  db.run(
    `INSERT INTO dma_changelog_events
     (event_hash, event_json, requested_since_ms, received_at, retention_class)
     VALUES (?, ?, ?, ?, 'durable_dma')`,
    hash,
    json,
    requestedSince,
    '2026-08-12T09:00:00.000Z',
  );
  return hash;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-mig17-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  // The database as it existed before this change shipped.
  migrate(db, MIGRATIONS.slice(0, 16));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('migration 017', () => {
  it('seeds the cursor from stored processedAt values, never from the wall-clock watermark', () => {
    const hashes = [
      seedLegacyEvent(
        {
          id: 1,
          activityId: 'act-1',
          resourceName: 'people',
          resourceId: 'urn:li:person:abc',
          method: 'PARTIAL_UPDATE',
          configVersion: 3,
          activityStatus: 'SUCCESS',
          capturedAt: OLDER_PROCESSED_AT - 100,
          processedAt: OLDER_PROCESSED_AT,
        },
        1,
      ),
      seedLegacyEvent(
        {
          id: 2,
          activityId: 'act-2',
          resourceName: 'people/positions',
          resourceId: 'pos-1',
          method: 'CREATE',
          activityStatus: 'SUCCESS',
          capturedAt: NEWEST_PROCESSED_AT - 100,
          processedAt: NEWEST_PROCESSED_AT,
        },
        1,
      ),
      // No processedAt at all.
      seedLegacyEvent({ id: 3, resourceName: 'people', method: 'PARTIAL_UPDATE' }, 1),
      // A corrupt far-future value: if this seeded the cursor, everything in
      // the retained window would be skipped and lost permanently.
      seedLegacyEvent({ id: 4, resourceName: 'people', processedAt: FAR_FUTURE }, 1),
    ];
    db.run(
      `INSERT INTO dma_changelog_watermarks
       (lane, watermark_ms, last_window_start_ms, last_synced_at, last_rows_fetched, last_rows_imported)
       VALUES ('member', ?, ?, ?, ?, ?)`,
      WALL_CLOCK_WATERMARK,
      1,
      '2026-08-12T09:00:00.000Z',
      4,
      4,
    );

    migrate(db);

    const row = db.get("SELECT * FROM dma_changelog_watermarks WHERE lane = 'member'")!;
    expect(Number(row['processed_at_cursor_ms'])).toBe(NEWEST_PROCESSED_AT);
    expect(Number(row['processed_at_cursor_ms'])).not.toBe(WALL_CLOCK_WATERMARK);
    expect(Number(row['cursor_repaired'])).toBe(1);
    // The old, wrong value is preserved as diagnostics rather than deleted.
    expect(Number(row['watermark_ms'])).toBe(WALL_CLOCK_WATERMARK);

    const maxProcessed = Number(
      db.get('SELECT MAX(processed_at_ms) AS m FROM dma_changelog_events')?.['m'],
    );
    expect(Number(row['processed_at_cursor_ms'])).toBeLessThanOrEqual(maxProcessed);

    // Every raw row survives, byte for byte, and none was rewritten.
    const events = db.all('SELECT event_hash, event_json FROM dma_changelog_events');
    expect(events).toHaveLength(4);
    expect(events.map((e) => String(e['event_hash'])).sort()).toEqual([...hashes].sort());
    for (const event of events) {
      const parsed = JSON.parse(String(event['event_json'])) as Record<string, unknown>;
      expect(createHash('sha256').update(String(event['event_json']), 'utf8').digest('hex')).toBe(
        String(event['event_hash']),
      );
      expect(parsed['id']).toBeDefined();
    }
  });

  it('backfills normalized metadata and rejects timestamps it cannot trust', () => {
    seedLegacyEvent(
      {
        id: 7,
        activityId: 'act-7',
        resourceName: 'people/positions',
        resourceId: 'pos-7',
        method: 'DELETE',
        configVersion: 2,
        activityStatus: 'FAILURE',
        capturedAt: NEWEST_PROCESSED_AT - 50,
        processedAt: NEWEST_PROCESSED_AT,
      },
      1,
    );
    seedLegacyEvent({ id: 8, resourceName: 'people', processedAt: '1786528100000' }, 1);
    seedLegacyEvent({ id: 9, resourceName: 'people', processedAt: FAR_FUTURE }, 1);

    migrate(db);

    const good = db.get("SELECT * FROM dma_changelog_events WHERE upstream_event_id = '7'")!;
    expect(good['resource_name']).toBe('people/positions');
    expect(good['resource_id']).toBe('pos-7');
    expect(good['method']).toBe('DELETE');
    expect(good['activity_id']).toBe('act-7');
    expect(Number(good['config_version'])).toBe(2);
    expect(good['activity_status']).toBe('FAILURE');
    expect(Number(good['processed_at_ms'])).toBe(NEWEST_PROCESSED_AT);

    // A string timestamp is not an integer timestamp; a year-3000 one is not
    // usable. Neither is coerced.
    expect(
      db.get("SELECT * FROM dma_changelog_events WHERE upstream_event_id = '8'")?.[
        'processed_at_ms'
      ],
    ).toBeNull();
    expect(
      db.get("SELECT * FROM dma_changelog_events WHERE upstream_event_id = '9'")?.[
        'processed_at_ms'
      ],
    ).toBeNull();
  });

  it('leaves the cursor null when there is nothing on disk to seed it from', () => {
    db.run(
      `INSERT INTO dma_changelog_watermarks
       (lane, watermark_ms, last_window_start_ms, last_synced_at, last_rows_fetched, last_rows_imported)
       VALUES ('member', ?, ?, ?, 0, 0)`,
      WALL_CLOCK_WATERMARK,
      1,
      '2026-08-12T09:00:00.000Z',
    );
    migrate(db);
    const row = db.get("SELECT * FROM dma_changelog_watermarks WHERE lane = 'member'")!;
    // Null means "no cursor known": the next sync reads the whole retained
    // window, which is the safe direction to be wrong in.
    expect(row['processed_at_cursor_ms']).toBeNull();
    expect(Number(row['cursor_repaired'])).toBe(1);
  });

  it('moves the misleading taken_at off DMA snapshots and preserves it', () => {
    db.run(
      `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
       VALUES ('src_legacy', 'manual', 'linkedin://dma', 'LinkedIn DMA API', 'personal_doc', 'enabled', ?)`,
      '2026-08-10T09:00:00.000Z',
    );
    db.run(
      `INSERT INTO linkedin_snapshots (id, source_kind, source_id, taken_at, imported_at, retention_class, version)
       VALUES ('snp_dma', 'dma_snapshot', 'src_legacy', ?, ?, 'durable_dma', 1)`,
      '2026-08-10T09:12:03.000Z',
      '2026-08-10T09:12:03.000Z',
    );
    // An export snapshot's taken_at is a real, user-supplied generation time.
    db.run(
      `INSERT INTO linkedin_snapshots (id, source_kind, source_id, taken_at, imported_at, retention_class, version)
       VALUES ('snp_csv', 'export_csv', 'src_legacy', ?, ?, 'durable_user', 2)`,
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
    );

    migrate(db);

    expect(
      db.get("SELECT taken_at FROM linkedin_snapshots WHERE id = 'snp_dma'")?.['taken_at'],
    ).toBeNull();
    expect(
      db.get("SELECT taken_at FROM linkedin_snapshots WHERE id = 'snp_csv'")?.['taken_at'],
    ).toBe('2026-07-01T00:00:00.000Z');

    const observation = db.get(
      "SELECT * FROM dma_snapshot_observations WHERE snapshot_id = 'snp_dma'",
    )!;
    expect(observation['request_completed_at']).toBe('2026-08-10T09:12:03.000Z');
    expect(Number(observation['backfilled'])).toBe(1);
    expect(String(observation['id'])).toBe('dmo_legacy_snp_dma');
    // Only DMA snapshots get one.
    expect(db.all('SELECT * FROM dma_snapshot_observations')).toHaveLength(1);
  });

  it('is idempotent through the runner and does not disturb an empty database', () => {
    // Derived, not hard-coded: beforeEach stops at 16, so this is every
    // migration added since, and a future one does not break the assertion.
    const first = migrate(db);
    expect(first.applied).toEqual(MIGRATIONS.filter((m) => m.version > 16).map((m) => m.version));
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(db.all('SELECT * FROM dma_snapshot_observations')).toHaveLength(0);
    expect(db.get('SELECT * FROM dma_changelog_watermarks')).toBeUndefined();
  });
});
