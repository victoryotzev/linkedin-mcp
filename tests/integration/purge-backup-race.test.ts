import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A backup that goes away while the purge is deciding whether it counts.
//
// All three surfaces ask the same question before an irreversible delete: is
// there a backup here that verifies? Answering it means listing the directory,
// resolving a name to a path, and reading a manifest — three separate looks at
// a filesystem the member is also using. If the manifest vanishes between the
// second look and the third, the honest answer is "this one does not count",
// not a crash on the way to a purge.

const MANIFEST = 'backup-manifest.json';
/** Calls per path, so the read that matters can fail while its siblings pass. */
const lstatCalls = new Map<string, number>();
let raceManifest = false;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (path: unknown, ...rest: unknown[]) => {
      const key = String(path);
      if (raceManifest && key.endsWith(MANIFEST)) {
        const seen = (lstatCalls.get(key) ?? 0) + 1;
        lstatCalls.set(key, seen);
        // The listing and the resolve both saw it; the verify does not.
        if (seen >= 3) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, '${key}'`), {
            code: 'ENOENT',
          });
        }
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

import type { SqliteDriver } from '@linkedin-mcp/db';
import type { SecretStore } from '@linkedin-mcp/domain';

const { migrate, openDatabase, ArtifactStore } = await import('@linkedin-mcp/db');
const { seedCapabilities, seedCanonicalSections } = await import('@linkedin-mcp/domain');
const { buildDashboardApp } = await import('../../linkedin-dashboard/src/app.ts');
const { DashboardAuth, SESSION_COOKIE } = await import('../../linkedin-dashboard/src/auth.ts');
const { runControlCommand, interactiveArgs } = await import('../../scripts/control.ts');
const { serverRequest } = await import('../helpers/clientHarness.ts');

let home: string;
let db: SqliteDriver;
let dbClosed = false;
let app: Hono;
let cookie: string;

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
  lstatCalls.clear();
  raceManifest = false;
  dbClosed = false;
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-race-purge-'));
  const opened = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  db = opened.db;
  migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);

  // A backup that is complete and correct on disk, so nothing but the race
  // can make it fail to count.
  const backup = join(home, 'backups', '2026-08-19T10-00-00-000Z');
  mkdirSync(backup, { recursive: true });
  const bytes = 'the database bytes';
  writeFileSync(join(backup, 'linkedin.sqlite3'), bytes, 'utf8');
  writeFileSync(
    join(backup, MANIFEST),
    JSON.stringify({
      format_version: 1,
      created_at: '2026-08-19T10:00:00.000Z',
      entries: [
        {
          path: 'linkedin.sqlite3',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
        },
      ],
    }),
    'utf8',
  );

  const auth = new DashboardAuth(4780);
  app = buildDashboardApp({
    db,
    store: new ArtifactStore(join(home, 'artifacts')),
    fts5: opened.fts5,
    home,
    auth,
    shutdown: () => {},
  });
  cookie = `${SESSION_COOKIE}=${auth.exchangeToken(auth.launchToken) ?? ''}`;
});

afterEach(() => {
  if (!dbClosed) db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

function runtime(): Parameters<typeof runControlCommand>[0] {
  return {
    db,
    home,
    secrets: memorySecrets(),
    // The real runtime closes the database before the purge deletes the home:
    // Windows will not remove a directory holding an open SQLite file.
    close() {
      if (dbClosed) return;
      db.close();
      dbClosed = true;
    },
  } as Parameters<typeof runControlCommand>[0];
}

/** One line per read, never before the loop turns — see the interactive suite. */
function typed(answers: readonly string[]): Readable {
  const remaining = [...answers];
  return new Readable({
    read() {
      setTimeout(() => {
        const next = remaining.shift();
        this.push(next === undefined ? null : `${next}\n`);
      }, 1);
    },
  });
}

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe('the dashboard purge route', () => {
  it('counts a backup whose manifest is still there', async () => {
    const response = await app.fetch(
      serverRequest(
        '/api/purge-all',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm_phrase: 'DELETE ALL LOCAL DATA' }),
        },
        cookie,
      ),
    );

    expect(response.status).toBeLessThan(400);
  });

  it('treats one that vanished mid-check as not counting, rather than failing', async () => {
    raceManifest = true;

    const response = await app.fetch(
      serverRequest(
        '/api/purge-all',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm_phrase: 'DELETE ALL LOCAL DATA' }),
        },
        cookie,
      ),
    );

    // Refused, and refused for the right reason: an unverifiable backup must
    // not unlock a delete, and it must not crash the request either.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toMatch(/verified backup/i);
  });
});

describe('the control CLI purge', () => {
  it('accepts the single phrase while the backup verifies', async () => {
    const out = (await runControlCommand(
      runtime(),
      ['purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA'],
      async () => 'unused',
    )) as { result: unknown };

    expect(out.result).toBeTruthy();
  }, 60_000);

  it('demands the second phrase when the backup vanished mid-check', async () => {
    raceManifest = true;

    await expect(
      runControlCommand(
        runtime(),
        ['purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA'],
        async () => 'unused',
      ),
    ).rejects.toThrow(/no verified backup/i);
  });
});

describe('the interactive purge', () => {
  async function menu(answers: readonly string[]): Promise<string[]> {
    const input = typed(answers);
    try {
      return await interactiveArgs(runtime(), { input, output: sink() });
    } finally {
      input.destroy();
    }
  }

  it('offers the single phrase while the backup verifies', async () => {
    const args = await menu(['10', 'DELETE ALL LOCAL DATA']);

    expect(args).toEqual(['purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA']);
  });

  it('asks for the harsher phrase when the backup vanished mid-check', async () => {
    raceManifest = true;

    const args = await menu(['10', 'DELETE ALL LOCAL DATA', 'NO BACKUP I ACCEPT PERMANENT LOSS']);

    // The member is asked to say out loud that this is unrecoverable, which is
    // the whole reason the second phrase exists.
    expect(args).toContain('--accept-no-backup');
  });
});
