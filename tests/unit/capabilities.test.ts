import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  disablePublishing,
  enablePublishing,
  listCapabilities,
  requireCapability,
  seedCapabilities,
} from '@linkedin-mcp/domain';
import { CAPABILITY_FEATURES, DomainError } from '@linkedin-mcp/shared';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-cap-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  seedCapabilities(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('capability registry', () => {
  it('seeds every feature as unavailable with the no_linkedin_app blocker', () => {
    const caps = listCapabilities(db);
    expect(caps.map((c) => c.feature).sort()).toEqual([...CAPABILITY_FEATURES].sort());
    for (const cap of caps) {
      expect(cap.status).toBe('unavailable');
      expect(cap.blockers).toEqual(['no_linkedin_app']);
      expect(cap.remediation).toContain('Token Generator');
    }
  });

  it('is idempotent and preserves existing rows on reseed', () => {
    db.run(
      "UPDATE capabilities SET status = 'verified', blockers_json = '[]' WHERE feature = 'linkedin.oidc_userinfo'",
    );
    seedCapabilities(db);
    const cap = listCapabilities(db, 'linkedin.oidc_userinfo')[0];
    expect(cap?.status).toBe('verified');
  });

  it('requireCapability fails closed for unavailable, unknown, and non-verified features', () => {
    for (const feature of ['linkedin.publish_post', 'linkedin.made_up_feature']) {
      try {
        requireCapability(db, feature);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('CAPABILITY_UNAVAILABLE');
      }
    }
  });

  it('requireCapability passes only for verified rows', () => {
    db.run(
      "UPDATE capabilities SET status = 'verified', blockers_json = '[]' WHERE feature = 'linkedin.oidc_userinfo'",
    );
    const cap = requireCapability(db, 'linkedin.oidc_userinfo');
    expect(cap.status).toBe('verified');
  });

  it('enables and disables publishing idempotently after write-lane verification', () => {
    db.run(
      `INSERT INTO linkedin_accounts (id, label, status, created_at, lane)
       VALUES ('acc_write', 'write', 'verified', ?, 'write')`,
      new Date().toISOString(),
    );
    db.run(
      `UPDATE capabilities SET status = 'configured', blockers_json = ?
       WHERE feature = 'linkedin.publish_post'`,
      JSON.stringify(['awaiting_explicit_enable']),
    );
    expect(enablePublishing(db, true, 'human_cli').status).toBe('verified');
    expect(enablePublishing(db, true, 'human_cli').status).toBe('verified');
    expect(disablePublishing(db, true, 'human_cli').status).toBe('disabled');
    expect(disablePublishing(db, true, 'human_cli').status).toBe('disabled');
    expect(
      db.get(
        "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'capability.publishing_enabled'",
      )?.['count'],
    ).toBe(1);
    expect(
      db.get(
        "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'capability.publishing_disabled'",
      )?.['count'],
    ).toBe(1);
  });
});
