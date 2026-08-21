import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAuditEvent,
  queryAuditEvents,
  registerSource,
  restrictSource,
  verifyAuditChain,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Two things a member has to be able to rely on: that the log says what
// happened, and that a source is what it claims to be.
//
// The chain is anchored at both ends. Verifying only the links would miss a
// tail that was cut off and re-written from an earlier point, which is exactly
// what someone editing the log would do — so the recorded head is checked too,
// and the two failures have to be told apart because they mean different
// things.

let fixture: Fixture;
let evidence: string;

beforeEach(() => {
  fixture = createFixture('ledger-and-sources');
  seedHealthy(fixture);
  // A seeded home writes one audited event; most of its setup goes in through
  // paths that are not themselves audited. A few more make the chain long
  // enough for the sequence and paging behaviour to mean anything.
  for (let i = 0; i < 4; i += 1) {
    appendAuditEvent(fixture.db, {
      event_type: 'test.seeded',
      actor: 'system',
      subject_type: 'claim',
      subject_id: `clm_seed_${i}`,
      payload: { index: i },
    });
  }
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-srcev-'));
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('the audit chain', () => {
  it('verifies a log nobody has touched', () => {
    const result = verifyAuditChain(fixture.db);

    expect(result.valid).toBe(true);
    expect(result.head_anchored).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('reports an entry whose body was edited after it was written', () => {
    fixture.db.run('UPDATE audit_events SET payload_json = \'{"tampered":true}\' WHERE seq = 1');

    const result = verifyAuditChain(fixture.db);

    expect(result.valid).toBe(false);
    expect(result.broken_at_seq).toBe(1);
    expect(result.reason).toMatch(/content_hash|edited/i);
  });

  it('reports entries sitting past the recorded head, links or no links', () => {
    // Winding the anchor back is the same shape as appending rows by direct SQL
    // and forging their hashes: the links agree with each other, and only the
    // anchor knows the log is longer than it should be.
    const earlier = fixture.db.get('SELECT seq, content_hash FROM audit_events WHERE seq = 2');
    fixture.db.run(
      "UPDATE settings SET value_json = ? WHERE key = 'audit.head'",
      JSON.stringify({ seq: 2, hash: String(earlier?.['content_hash']) }),
    );

    const result = verifyAuditChain(fixture.db);

    // Nothing writes this table outside appendAuditEvent, and that moves the
    // anchor in the same transaction, so rows beyond the head arrived another
    // way. The message says exactly that.
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/past the recorded head|outside the append path/i);
    expect(result.head_anchored).toBe(true);
    expect(result.broken_at_seq).toBe(3);
  });

  it('reports a tail that was cut off and rewritten', () => {
    const before = verifyAuditChain(fixture.db);
    fixture.db.run('DELETE FROM audit_events WHERE seq = (SELECT MAX(seq) FROM audit_events)');

    const result = verifyAuditChain(fixture.db);

    // The links still agree with each other; only the anchor knows the log used
    // to be longer. This is the case anchoring exists for, and the message
    // names how many entries went missing rather than saying "invalid".
    expect(before.valid).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/deleted/i);
    expect(result.reason).toMatch(/\d+ events were written/i);
  });

  it('reports a missing anchor rather than trusting the links alone', () => {
    fixture.db.run("DELETE FROM settings WHERE key = 'audit.head'");

    const result = verifyAuditChain(fixture.db);

    expect(result.head_anchored).toBe(false);
  });

  it('survives an anchor that is not the shape it should be', () => {
    for (const value of ['not json', '{}', '{"seq":"one","hash":2}', 'null']) {
      fixture.db.run(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('audit.head', ?, ?) " +
          'ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json',
        value,
        new Date().toISOString(),
      );

      // A malformed anchor reads as no anchor, not as a crash: the member still
      // needs to be told the links themselves are intact.
      const result = verifyAuditChain(fixture.db);
      expect(result.head_anchored, value).toBe(false);
    }
  });

  it('keeps appending after a verified read', () => {
    const before = verifyAuditChain(fixture.db).length;
    appendAuditEvent(fixture.db, {
      event_type: 'test.event',
      actor: 'system',
      subject_type: 'claim',
      subject_id: 'clm_test',
      payload: { note: 'still fine' },
    });

    const after = verifyAuditChain(fixture.db);
    expect(after.length).toBe(before + 1);
    expect(after.valid).toBe(true);
  });
});

describe('querying the log', () => {
  it('filters by type, subject and time, and pages', () => {
    const all = queryAuditEvents(fixture.db, {});
    expect(all.length).toBeGreaterThan(0);

    const typed = queryAuditEvents(fixture.db, { event_type: all[0]!.event_type });
    for (const event of typed) expect(event.event_type).toBe(all[0]!.event_type);

    const since = queryAuditEvents(fixture.db, { since: '2000-01-01T00:00:00.000Z' });
    expect(since.length).toBe(all.length);

    const future = queryAuditEvents(fixture.db, { since: '2999-01-01T00:00:00.000Z' });
    expect(future).toEqual([]);

    const paged = queryAuditEvents(fixture.db, { limit: 2, offset: 1 });
    expect(paged.length).toBeLessThanOrEqual(2);
  });

  it('pins a maximum sequence, so a page cannot shift under a reader', () => {
    const all = queryAuditEvents(fixture.db, {});
    expect(all.length).toBeGreaterThan(2);
    const pinned = queryAuditEvents(fixture.db, { max_seq: 2 });

    // Without this, appending while someone pages through the log silently
    // shifts every later page under them.
    expect(pinned.every((e) => e.seq <= 2)).toBe(true);
    expect(pinned.length).toBeLessThan(all.length);
  });
});

describe('registering a source', () => {
  function dir(): string {
    return evidence;
  }
  function file(name = 'cv.pdf'): string {
    const path = join(evidence, name);
    writeFileSync(path, 'a document');
    return path;
  }

  const register = (path: string, kind: 'repo' | 'document' | 'folder' | 'linkedin_export') =>
    registerSource(fixture.db, {
      path,
      kind,
      trust: 'own_repo',
      label: `${kind} source`,
      dataHome: fixture.dir,
    });

  it('requires a file for the kinds that describe one', () => {
    for (const kind of ['document', 'linkedin_export'] as const) {
      // Pointing 'document' at a directory is a mistake worth catching at
      // registration rather than at the first confusing import.
      expect(() => register(dir(), kind), kind).toThrow(/expects a file path/i);
    }
  });

  it('requires a directory for the kinds that describe one', () => {
    for (const kind of ['repo', 'folder'] as const) {
      expect(() => register(file(`${kind}.txt`), kind), kind).toThrow(/expects a directory path/i);
    }
  });

  it('refuses to register the same path twice', () => {
    register(dir(), 'repo');

    // Two sources over one directory would double-count everything under it.
    expect(() => register(dir(), 'repo')).toThrow(/already registered/i);
  });

  it('refuses a path that does not exist', () => {
    expect(() => register(join(evidence, 'nowhere'), 'repo')).toThrow();
  });
});

describe('restricting a source', () => {
  it('disables one, so nothing new is imported from it', () => {
    const source = registerSource(fixture.db, {
      path: evidence,
      kind: 'repo',
      trust: 'own_repo',
      label: 'a repo',
      dataHome: fixture.dir,
    });

    const disabled = restrictSource(fixture.db, source.id, 'disable');

    expect(disabled.status).toBe('disabled');
    // The artifacts already imported from it stay: disabling is about what
    // happens next, not about erasing what happened.
    expect(Number(fixture.db.get('SELECT COUNT(*) AS n FROM artifacts')?.['n'])).toBeGreaterThan(0);
  });

  it('archives one', () => {
    const source = registerSource(fixture.db, {
      path: evidence,
      kind: 'repo',
      trust: 'own_repo',
      label: 'a repo',
      dataHome: fixture.dir,
    });

    expect(restrictSource(fixture.db, source.id, 'archive').status).toBe('archived');
  });

  it('refuses a source it does not know', () => {
    expect(() => restrictSource(fixture.db, 'src_nope', 'disable')).toThrow();
  });
});
