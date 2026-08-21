import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Row, SqlValue, SqliteDriver } from '@linkedin-mcp/db';
import {
  configureLane,
  getFeatureControl,
  listCapabilities,
  runBackup,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The last few control-CLI paths, each of which needs the machine set up first.
//
// The CLI is the dashboard-free human-authority surface: it is where a person
// enables a source, grants an approval, stores a credential, or destroys
// everything. Its neighbours cover the command table and the interactive menu.
// What is left here is the handful of branches that only run once a lane has
// actually verified, a backup actually exists, or the terminal actually
// answers — and the one that runs when something other than a refusal escapes.

let maskedAnswer: { status: number; stdout: string } = { status: 0, stdout: 'a-typed-token\r\n' };

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (exe: string, args: readonly string[], opts?: unknown) => {
      const encoded = args[args.indexOf('-EncodedCommand') + 1] ?? '';
      const script = Buffer.from(encoded, 'base64').toString('utf16le');
      // Only the masked prompt is stood in for. It reads from an inherited
      // terminal, which a test runner does not have.
      if (!script.includes('Read-Host')) {
        return (actual.spawnSync as (...a: unknown[]) => unknown)(exe, args, opts);
      }
      return { status: maskedAnswer.status, stdout: maskedAnswer.stdout, stderr: '' };
    },
  };
});

const { runControlCommand, interactiveArgs, main, promptMaskedSecret } = await import(
  '../../scripts/control.ts'
);
type ControlRuntime = Parameters<typeof runControlCommand>[0];

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  vi.unstubAllGlobals();
  maskedAnswer = { status: 0, stdout: 'a-typed-token\r\n' };
});

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

function runtime(): ControlRuntime & { fixture: Fixture } {
  const fixture = createFixture('control-edges');
  fixtures.push(fixture);
  seedHealthy(fixture);
  return {
    fixture,
    db: fixture.db,
    home: fixture.dir,
    secrets: memorySecrets(),
    close() {},
  } as ControlRuntime & { fixture: Fixture };
}

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';
const run = (rt: ControlRuntime, ...args: string[]) =>
  runControlCommand(rt, args, async () => TOKEN);

function captureOut(): Writable & { text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { text(): string };
  stream.text = () => chunks.join('');
  return stream;
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

describe('proving a lane from the CLI', () => {
  it('reports what the probe opened when LinkedIn answers', async () => {
    const rt = runtime();
    await run(rt, 'lane', 'configure', 'read', '--client-id', 'cid-read');
    vi.stubGlobal('fetch', async (input: unknown) => {
      // The walk ends on an empty page; a stub that always answers with rows
      // runs to the page cap and reports a snapshot that never terminated.
      const page = Number(/start=(\d+)/.exec(String(input))?.[1] ?? '0');
      return new Response(
        JSON.stringify({
          elements: [
            {
              snapshotDomain: 'PROFILE',
              snapshotData: page > 0 ? [] : [{ 'First Name': 'Alex' }],
            },
          ],
          paging: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const out = (await run(rt, 'lane', 'verify', 'read')) as {
      result: { lane: string; verified: string[] };
    };

    // The list is what the member acts on: a probe that succeeds without
    // opening anything is a different situation from one that opens the lane.
    expect(out.result.lane).toBe('read');
    expect(out.result.verified.length).toBeGreaterThan(0);
    expect(listCapabilities(rt.db, 'linkedin.dma_snapshot')[0]?.status).toBe('verified');
  }, 60_000);
});

describe('turning publishing off through the feature key', () => {
  it('closes the capability, not just the switch', async () => {
    const rt = runtime();
    const secrets = rt.secrets;
    await configureLane(rt.db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await verifyLane(
      rt.db,
      secrets,
      'write',
      async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
      'human_cli',
    );
    await run(rt, 'feature', 'enable', 'live_publishing', '--confirm');
    expect(listCapabilities(rt.db, 'linkedin.publish_post')[0]?.status).toBe('verified');

    await run(rt, 'feature', 'disable', 'live_publishing', '--confirm');

    // Leaving the capability open with the switch off would mean the publish
    // path still passed its gate while the member believed it was shut.
    expect(getFeatureControl(rt.db, 'live_publishing').enabled).toBe(false);
    expect(listCapabilities(rt.db, 'linkedin.publish_post')[0]?.status).not.toBe('verified');
  });

  it('lists every switch with its current value', async () => {
    const out = (await run(runtime(), 'feature', 'list')) as {
      features: Array<{ key: string; enabled: boolean }>;
    };

    expect(out.features).toHaveLength(9);
    expect(out.features.find((f) => f.key === 'live_publishing')?.enabled).toBe(false);
  });
});

describe('the full purge from the CLI, with backups on disk', () => {
  it('accepts the single phrase once one of them verifies', async () => {
    const rt = runtime();
    await runBackup(rt.db, rt.home, { actor: 'dashboard' });

    const out = (await run(rt, 'purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA')) as {
      result: unknown;
    };

    // No second phrase: a verified backup is the whole reason the harsher
    // confirmation exists, so demanding it anyway would teach members to type
    // it without reading.
    expect(out.result).toBeTruthy();
  }, 60_000);

  it('still demands the second phrase when the only backup cannot be verified', async () => {
    const rt = runtime();
    const stray = join(rt.home, 'backups', 'dropped in by hand');
    mkdirSync(stray, { recursive: true });
    writeFileSync(
      join(stray, 'backup-manifest.json'),
      JSON.stringify({ format_version: 1, created_at: '', entries: [] }),
      'utf8',
    );

    await expect(run(rt, 'purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA')).rejects.toThrow(
      /backup/i,
    );
  });
});

describe('the interactive purge, with backups on disk', () => {
  async function menu(answers: readonly string[], rt: ControlRuntime): Promise<string[]> {
    const input = typed(answers);
    try {
      return await interactiveArgs(rt, { input, output: captureOut() });
    } finally {
      input.destroy();
    }
  }

  it('demands the second phrase when the only backup cannot be verified', async () => {
    const rt = runtime();
    const stray = join(rt.home, 'backups', 'dropped in by hand');
    mkdirSync(stray, { recursive: true });
    writeFileSync(
      join(stray, 'backup-manifest.json'),
      JSON.stringify({ format_version: 1, created_at: '', entries: [] }),
      'utf8',
    );

    const args = await menu(
      ['10', 'DELETE ALL LOCAL DATA', 'NO BACKUP I ACCEPT PERMANENT LOSS'],
      rt,
    );

    // A folder in the backups directory is not a backup. Counting it would
    // skip the one confirmation that exists to say "this is unrecoverable".
    expect(args).toContain('--accept-no-backup');
  });
});

describe('the masked credential prompt', () => {
  it('returns what was typed, trimmed, and never puts it in argv', async () => {
    maskedAnswer = { status: 0, stdout: '  a-typed-token\r\n' };

    // A pasted token routinely carries a trailing newline, which becomes an
    // invalid Authorization header hours later and reads as a revoked token.
    expect(await promptMaskedSecret()).toBe('a-typed-token');
  });

  it('reports a failure without a secret when the host refuses', async () => {
    maskedAnswer = { status: 1, stdout: '' };

    await expect(promptMaskedSecret()).rejects.toThrow(/no secret was stored/i);
  });
});

describe('something other than a refusal escaping', () => {
  it('prints a plain message rather than a stack trace', async () => {
    const rt = runtime();
    const broken: SqliteDriver = {
      ...rt.db,
      exec: (sql: string) => rt.db.exec(sql),
      run: (sql: string, ...params: SqlValue[]) => rt.db.run(sql, ...params),
      get: (sql: string, ...params: SqlValue[]): Row | undefined => rt.db.get(sql, ...params),
      all: (): Row[] => {
        throw new Error('the database file is on a disconnected drive');
      },
      backupTo: (dest: string) => rt.db.backupTo(dest),
      close: () => rt.db.close(),
    };
    const errors = captureOut();
    const previousExitCode = process.exitCode;

    await main(['status'], { input: typed([]), output: captureOut() }, errors, {
      ...rt,
      db: broken,
      close() {},
    } as ControlRuntime);

    // A refusal is JSON the member can read; anything else is a bug, and its
    // message on one line beats a stack trace on a terminal.
    expect(errors.text()).toMatch(/control CLI failed/i);
    expect(errors.text()).toMatch(/disconnected drive/i);
    expect(errors.text()).not.toMatch(/ {4}at /);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});
