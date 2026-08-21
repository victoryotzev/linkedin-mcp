import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAuditEvent,
  configureLane,
  enableSourceFromDashboard,
  executePublication,
  grantApproval,
  readinessReport,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { DryRunPublisher } from '@linkedin-mcp/linkedin';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import {
  createFixture,
  seedHealthy,
  seedPendingSource,
  type Fixture,
} from '../helpers/fixtures.ts';

// The audit cursor, and the two readiness checks that only answer differently
// once something has been set up.
//
// A pagination cursor is caller-supplied, so it is untrusted input reaching a
// SQL LIMIT/OFFSET. It is validated shape and range before it goes anywhere,
// and a cursor that does not survive that is refused rather than coerced —
// coercion would silently show the member a different page than the one they
// asked for.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;
let call: (name: string, args: unknown) => Promise<unknown>;

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    async put(name, value) {
      values.set(name, value);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    has(name) {
      return values.has(name);
    },
    listNames() {
      return [...values.keys()].sort();
    },
    async remove(name) {
      values.delete(name);
    },
  };
}

beforeEach(() => {
  fixture = createFixture('audit-cursor');
  seeded = seedHealthy(fixture);
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
  } as never);
  call = async (name, args) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
});

afterEach(() => fixture.close());

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('the audit pagination cursor', () => {
  it('round-trips through a page boundary', async () => {
    for (let i = 0; i < 6; i += 1) {
      appendAuditEvent(fixture.db, {
        event_type: 'test.event',
        actor: 'system',
        subject_type: 'claim',
        subject_id: `clm_${i}`,
        payload: { i },
      });
    }

    const first = (await call('linkedin_audit_query', { limit: 2 })) as {
      events: Array<{ seq: number }>;
      next_cursor?: string;
      has_more: boolean;
    };
    expect(first.has_more).toBe(true);
    if (!first.next_cursor) return;

    const second = (await call('linkedin_audit_query', {
      limit: 2,
      cursor: first.next_cursor,
    })) as { events: Array<{ seq: number }> };

    const firstSeqs = new Set(first.events.map((e) => e.seq));
    expect(second.events.some((e) => firstSeqs.has(e.seq))).toBe(false);
  });

  it('refuses a cursor that is not base64url JSON', async () => {
    for (const cursor of ['not-a-cursor', '!!!!', 'eyJib2d1cw']) {
      await expect(call('linkedin_audit_query', { cursor }), cursor).rejects.toThrow(
        /malformed audit pagination cursor/i,
      );
    }
  });

  it('refuses a cursor whose values are not whole non-negative numbers', async () => {
    for (const value of [
      { maxSeq: -1, offset: 0 },
      { maxSeq: 0, offset: -1 },
      { maxSeq: 1.5, offset: 0 },
      { maxSeq: 0, offset: 2.5 },
      { maxSeq: 'ten', offset: 0 },
      { maxSeq: 0 },
      {},
      [],
      null,
    ]) {
      // Coercing would silently show a different page than the one asked for,
      // and this cursor reaches a SQL LIMIT/OFFSET.
      await expect(
        call('linkedin_audit_query', { cursor: encode(value) }),
        JSON.stringify(value),
      ).rejects.toThrow(/malformed audit pagination cursor/i);
    }
  });

  it('accepts a well-formed cursor built by hand', async () => {
    const out = (await call('linkedin_audit_query', {
      cursor: encode({ maxSeq: 1, offset: 0 }),
    })) as { events: Array<{ seq: number }> };

    expect(out.events.every((e) => e.seq <= 1)).toBe(true);
  });

  it('reports the publication history alongside the log', async () => {
    grantApproval(fixture.db, seeded.approvalId, 'dashboard');
    await executePublication(fixture.db, new DryRunPublisher(), {
      approval_id: seeded.approvalId,
    });

    const out = (await call('linkedin_audit_query', {})) as {
      publications: Array<{ id: string; outcome: string }>;
    };

    // The log says what happened; the publications say what is on the profile.
    // A member checking one almost always wants the other.
    expect(out.publications.length).toBeGreaterThan(0);
    expect(out.publications[0]?.outcome).toBeTruthy();
  });
});

describe('the readiness checks that change once things exist', () => {
  it('reports the schema as ok, counting the migrations that ran', () => {
    const check = readinessReport(fixture.db, { home: fixture.dir }).checks.find(
      (c) => c.id === 'schema',
    );

    expect(check?.status).toBe('ok');
    expect(check?.detail).toMatch(/\d+ migrations applied/);
    expect(check?.remediation).toBeNull();
  });

  it('reports a schema with nothing applied as something to fix', () => {
    fixture.db.run('DELETE FROM schema_migrations');

    const check = readinessReport(fixture.db, { home: fixture.dir }).checks.find(
      (c) => c.id === 'schema',
    );

    // Migrations run at every start, so a shortfall means a start that failed
    // rather than one that has not happened — and the remedy says so.
    expect(check?.status).toBe('action_needed');
    expect(check?.remediation).toMatch(/restart|restore/i);
  });

  it('reports the LinkedIn connection as ok once a capability is verified', async () => {
    const secrets = memorySecrets();
    await configureLane(fixture.db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: 'AQV-fake-fixture-token-not-a-real-credential-0123456789',
    });
    await verifyLane(fixture.db, secrets, 'read', async () => ({ ok: true }), 'dashboard');

    const check = readinessReport(fixture.db, { home: fixture.dir }).checks.find(
      (c) => c.id === 'linkedin',
    );

    expect(check?.status).toBe('ok');
    // Counted rather than asserted: a member with one of five verified should
    // see that, not a green tick.
    expect(check?.detail).toMatch(/\d+ of \d+ capabilities verified/);
  });

  it('counts a pending source separately from an enabled one', () => {
    const pendingId = seedPendingSource(fixture.db);
    seedPendingSource(fixture.db);
    enableSourceFromDashboard(fixture.db, pendingId);

    const report = readinessReport(fixture.db, { home: fixture.dir });

    expect(report.counts.sources_pending).toBeGreaterThan(0);
    expect(report.counts.sources_enabled).toBeGreaterThan(0);
  });
});
