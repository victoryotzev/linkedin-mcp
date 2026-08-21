import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  FEATURE_KEYS,
  listFeatureControls,
  requireFeatureEnabled,
  setFeatureControl,
} from '@linkedin-mcp/domain';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-features-'));
  db = openDatabase(join(dir, 'features.sqlite3')).db;
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('shared feature controls', () => {
  it('defaults only real account publishing to disabled', () => {
    const features = listFeatureControls(db);
    expect(features.map((feature) => feature.key)).toEqual(FEATURE_KEYS);
    expect(features.filter((feature) => !feature.enabled).map((feature) => feature.key)).toEqual([
      'live_publishing',
    ]);
    expect(features.every((feature) => feature.description.length > 20)).toBe(true);
  });

  it('persists one policy used by every process and records the actor', () => {
    setFeatureControl(db, 'evidence', false, { confirm: true, actor: 'human_cli' });
    setFeatureControl(db, 'evidence', false, { confirm: true, actor: 'human_cli' });
    expect(() => requireFeatureEnabled(db, 'evidence')).toThrowError(/disabled/);
    expect(listFeatureControls(db).find((feature) => feature.key === 'evidence')?.enabled).toBe(
      false,
    );
    expect(
      db.get("SELECT actor FROM audit_events WHERE event_type = 'feature.disabled'"),
    ).toMatchObject({
      actor: 'human_cli',
    });
    expect(
      db.get("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'feature.disabled'")?.[
        'count'
      ],
    ).toBe(1);
  });

  it('requires confirmation and refuses corrupt policy instead of re-enabling defaults', () => {
    expect(() =>
      setFeatureControl(db, 'content', false, { confirm: false, actor: 'mcp_host' }),
    ).toThrowError(/confirm/);
    db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      'features.enabled',
      '{broken',
      new Date().toISOString(),
    );
    expect(() => listFeatureControls(db)).toThrowError(/unreadable/);
  });
});
