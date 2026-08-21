import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, SqlValue, SqliteDriver } from '@linkedin-mcp/db';
import {
  executePublication,
  grantApproval,
  runBackup,
  writeDraft,
  validateDraft,
  requestApproval,
} from '@linkedin-mcp/domain';
import { DryRunPublisher } from '@linkedin-mcp/linkedin';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The last checks before a post leaves, and the last check before everything
// local is destroyed.
//
// Both are one-way doors, so both are guarded by a re-read rather than by what
// the caller was holding. An approval is proved still granted, still unexpired
// and still about this exact text at the moment it is consumed — not at the
// moment it was fetched. A purge is refused unless a backup has actually been
// verified, and a folder someone dropped into the backups directory by hand is
// not a backup.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;

beforeEach(() => {
  fixture = createFixture('publish-purge-guards');
  seeded = seedHealthy(fixture);
});

afterEach(() => fixture.close());

function tools(withPurgeHook = true): (name: string, args: unknown) => Promise<unknown> {
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
    ...(withPurgeHook ? { scheduleFullPurge: () => {} } : {}),
  } as never);
  return async (name, args) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
}

describe('consuming an approval', () => {
  /** A driver that reports the approval as already consumed by someone else. */
  function racingDriver(): SqliteDriver {
    const real = fixture.db;
    return {
      exec: (sql) => real.exec(sql),
      get: (sql, ...params) => real.get(sql, ...params),
      all: (sql, ...params) => real.all(sql, ...params),
      backupTo: (dest) => real.backupTo(dest),
      close: () => real.close(),
      run: (sql: string, ...params: SqlValue[]): RunResult => {
        if (sql.includes("SET state = 'consumed'")) return { changes: 0, lastInsertRowid: 0 };
        return real.run(sql, ...params);
      },
    };
  }

  it('refuses when the conditional consume matched nothing', async () => {
    grantApproval(fixture.db, seeded.approvalId, 'dashboard');

    // The approval is consumed by a conditional UPDATE inside the same
    // transaction that records the intent, and the send happens only after.
    // If that UPDATE matched no row, someone else already has this approval —
    // and sending anyway is how one approval becomes two posts.
    await expect(
      executePublication(racingDriver(), new DryRunPublisher(), {
        approval_id: seeded.approvalId,
      }),
    ).rejects.toThrow(/consumed or invalidated concurrently/i);

    expect(
      String(
        fixture.db.get('SELECT state FROM approvals WHERE id = ?', seeded.approvalId)?.['state'],
      ),
    ).toBe('granted');
  });

  it('refuses an approval that has expired, and leaves it granted', async () => {
    grantApproval(fixture.db, seeded.approvalId, 'dashboard');
    fixture.db.run(
      'UPDATE approvals SET expires_at = ? WHERE id = ?',
      new Date(Date.now() - 60_000).toISOString(),
      seeded.approvalId,
    );

    await expect(
      executePublication(fixture.db, new DryRunPublisher(), { approval_id: seeded.approvalId }),
    ).rejects.toThrow(/expired at/i);

    // Deliberately not transitioned here: this runs inside the caller's
    // transaction, so a write would roll back with the throw and the approval
    // would sit 'granted' forever while occupying its draft's one live slot.
    // The retention sweep owns that transition.
    expect(
      String(
        fixture.db.get('SELECT state FROM approvals WHERE id = ?', seeded.approvalId)?.['state'],
      ),
    ).toBe('granted');
  });

  it('refuses once the draft has changed underneath it', async () => {
    const { draft } = writeDraft(fixture.db, {
      body_text: 'The suite covers 187 test files in total.',
      slug: 'drifting-draft',
    });
    validateDraft(fixture.db, draft.id);
    const { approval } = requestApproval(fixture.db, { draft_id: draft.id });
    grantApproval(fixture.db, approval.id, 'dashboard');

    // Editing the draft invalidates the approval on the spot, which is the
    // first line of defence.
    writeDraft(fixture.db, {
      draft_id: draft.id,
      body_text: 'The suite covers 1,204 test files in total.',
    });
    expect(
      String(fixture.db.get('SELECT state FROM approvals WHERE id = ?', approval.id)?.['state']),
    ).toBe('invalidated');

    // This is the second. Putting the row back to 'granted' is what a writer
    // that changed the draft some other way would leave behind, and the hash
    // comparison catches it without trusting the state column.
    fixture.db.run("UPDATE approvals SET state = 'granted' WHERE id = ?", approval.id);

    await expect(
      executePublication(fixture.db, new DryRunPublisher(), { approval_id: approval.id }),
    ).rejects.toThrow(/draft changed after approval/i);
  });
});

describe('the full purge through the MCP tool', () => {
  it('refuses in a process that cannot shut the server down', async () => {
    // The tool schedules a shutdown; without that hook it would delete the home
    // out from under a server still serving requests against it.
    await expect(
      tools(false)('linkedin_purge_run', {
        mode: 'purge_all',
        confirm_phrase: 'DELETE ALL LOCAL DATA',
        accept_no_backup: true,
        confirm: true,
      }),
    ).rejects.toThrow(/shutdown hook is unavailable/i);
  });

  it('does not count a folder someone dropped into the backups directory', async () => {
    const stray = join(fixture.dir, 'backups', 'not a managed name');
    mkdirSync(stray, { recursive: true });
    writeFileSync(
      join(stray, 'backup-manifest.json'),
      JSON.stringify({
        format_version: 1,
        created_at: new Date().toISOString(),
        entries: [{ path: 'linkedin.sqlite3', bytes: 1, sha256: 'a'.repeat(64) }],
      }),
      'utf8',
    );

    // It lists, because refusing to show it would hide something the member
    // put there. It cannot be verified, because it is not a managed backup —
    // and an unverifiable folder must not unlock an irreversible delete.
    await expect(
      tools()('linkedin_purge_run', {
        mode: 'purge_all',
        confirm_phrase: 'DELETE ALL LOCAL DATA',
        confirm: true,
      }),
    ).rejects.toThrow(/no verified backup/i);
  });

  it('proceeds once a real backup verifies', async () => {
    await runBackup(fixture.db, fixture.dir, { actor: 'mcp_host' });

    const out = (await tools()('linkedin_purge_run', {
      mode: 'purge_all',
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      confirm: true,
    })) as { status: string };

    expect(out.status).toBe('purging');
  }, 60_000);
});

describe('purging the portability lane on its own', () => {
  it('prunes events older than a date without touching the rest', async () => {
    const out = (await tools()('linkedin_purge_run', {
      mode: 'prune_dma',
      before: '2026-01-01T00:00:00.000Z',
      confirm: true,
    })) as { mode: string; dma: Record<string, unknown> };

    expect(out.mode).toBe('prune_dma');
    expect(out.dma).toBeTruthy();
  });

  it('deletes the whole portability corpus when that is the mode', async () => {
    const out = (await tools()('linkedin_purge_run', {
      mode: 'purge_dma',
      confirm_phrase: 'DELETE LINKEDIN PORTABILITY DATA',
      confirm: true,
    })) as { mode: string; dma: Record<string, unknown> };

    // Separate from the full purge because the member may want LinkedIn's copy
    // of their history gone without destroying their own evidence ledger.
    expect(out.mode).toBe('purge_dma');
    expect(out.dma).toBeTruthy();
  });

  it('refuses either without a confirmation', async () => {
    for (const mode of ['prune_dma', 'purge_dma']) {
      await expect(tools()('linkedin_purge_run', { mode }), mode).rejects.toBeTruthy();
    }
  });
});
