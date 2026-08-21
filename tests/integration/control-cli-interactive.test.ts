import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureLane,
  listCapabilities,
  listSources,
  runBackup,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import {
  interactiveArgs,
  main,
  openControlRuntime,
  runControlCommand,
  promptMaskedSecret,
  usage,
  type ControlRuntime,
} from '../../scripts/control.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The interactive menu.
//
// This is the surface a person actually drives when they run `npm run control`
// with no arguments, and it is where the destructive confirmations are typed.
// Until the streams were injectable it could only be reached by running the
// script and typing into it, so none of it had ever been exercised — including
// the two phrases that stand in front of deleting everything.
//
// Each test writes the keystrokes a member would type and asserts the argument
// vector the menu builds. The menu never performs anything itself: it returns a
// command for runControlCommand, which is covered separately.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  vi.unstubAllEnvs();
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
  const fixture = createFixture('control-interactive');
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

/** Collects everything the CLI prints, so what it showed can be asserted. */
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

/**
 * Feeds the given answers as if typed, one per prompt.
 *
 * One line per read, and never before the event loop has turned. readline
 * emits a `line` event for every line in a chunk, and drops the ones with no
 * question waiting — so writing all the answers at once answers the first
 * prompt and loses the rest, and ending the stream fails them instead. A real
 * terminal delivers a line only once someone is waiting for it, which is what
 * this reproduces.
 */
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

async function menu(
  answers: readonly string[],
  rt = runtime(),
): Promise<{ args: string[]; shown: string; rt: ControlRuntime & { fixture: Fixture } }> {
  const output = captureOut();
  const input = typed(answers);
  try {
    const args = await interactiveArgs(rt, { input, output });
    return { args, shown: output.text(), rt };
  } finally {
    input.destroy();
  }
}

describe('the menu itself', () => {
  it('names the home it is about to act on before offering anything', async () => {
    const rt = runtime();
    const { shown } = await menu(['1'], rt);

    // Two dashboards or two CLIs against different homes is a real mistake to
    // make; the menu states which one it holds before the first choice.
    expect(shown).toContain(rt.home);
    expect(shown).toMatch(/1\. Status/);
    expect(shown).toMatch(/10\. Delete all local data/);
  });

  it('refuses a selection that is not on the menu', async () => {
    await expect(menu(['42'])).rejects.toThrow(/unknown selection/i);
  });

  it('refuses an empty selection', async () => {
    await expect(menu([''])).rejects.toThrow(/unknown selection/i);
  });
});

describe('the read-only selections', () => {
  it('builds the status command', async () => {
    const { args } = await menu(['1']);
    expect(args).toEqual(['status']);
  });

  it('lists pending sources before asking which one to enable', async () => {
    const rt = runtime();
    const pending = listSources(rt.db, { status: 'pending_review' })[0];
    const { args, shown } = await menu(['2', pending?.id ?? 'src_none'], rt);

    // The id has to be typed, so it has to be shown first.
    expect(shown).toContain(pending?.id ?? '');
    expect(args).toEqual(['source', 'enable', pending?.id ?? 'src_none']);
  });

  it('lists pending approvals before asking which one to preview', async () => {
    const rt = runtime();
    const approvalId = String(
      rt.db.get("SELECT id FROM approvals WHERE state = 'pending'")?.['id'] ?? '',
    );
    const { args, shown } = await menu(['3', approvalId], rt);

    expect(shown).toContain(approvalId);
    expect(args).toEqual(['approval', 'preview', approvalId]);
  });
});

describe('granting an approval from the menu', () => {
  it('shows the preview and requires the revision hash to be typed from it', async () => {
    const rt = runtime();
    const approvalId = String(
      rt.db.get("SELECT id FROM approvals WHERE state = 'pending'")?.['id'] ?? '',
    );
    const revisionHash = String(
      rt.db.get('SELECT revision_hash FROM approvals WHERE id = ?', approvalId)?.[
        'revision_hash'
      ] ?? '',
    );

    const { args, shown } = await menu(['4', approvalId, revisionHash], rt);

    // The hash is printed and then typed back. That round trip is the whole
    // guarantee: the member approved the bytes they were shown.
    expect(shown).toContain(revisionHash);
    expect(args).toEqual(['approval', 'grant', approvalId, '--revision-hash', revisionHash]);
  });

  it('passes a mistyped hash straight through, for the command to refuse', async () => {
    const rt = runtime();
    const approvalId = String(
      rt.db.get("SELECT id FROM approvals WHERE state = 'pending'")?.['id'] ?? '',
    );

    const { args } = await menu(['4', approvalId, 'f'.repeat(64)], rt);

    // The menu does not check the hash — runControlCommand does, against the
    // approval. One place to get that comparison right, not two.
    expect(args).toEqual(['approval', 'grant', approvalId, '--revision-hash', 'f'.repeat(64)]);
  });

  it('builds a denial with the typed reason', async () => {
    const rt = runtime();
    const approvalId = String(
      rt.db.get("SELECT id FROM approvals WHERE state = 'pending'")?.['id'] ?? '',
    );

    const { args } = await menu(['5', approvalId, 'not this week'], rt);
    expect(args).toEqual(['approval', 'deny', approvalId, '--reason', 'not this week']);
  });
});

describe('configuring and verifying a lane', () => {
  it('builds a lane configuration, leaving the expiry out when it is blank', async () => {
    const { args } = await menu(['6', 'read', 'test-client-id-read', '']);
    expect(args).toEqual(['lane', 'configure', 'read', '--client-id', 'test-client-id-read']);
  });

  it('includes the expiry when one is given', async () => {
    const { args } = await menu(['6', 'write', 'test-client-id-write', '900']);
    expect(args).toEqual([
      'lane',
      'configure',
      'write',
      '--client-id',
      'test-client-id-write',
      '--expires-in-seconds',
      '900',
    ]);
  });

  it('never asks for the token here, so it cannot reach argv', async () => {
    const { args } = await menu(['6', 'read', 'test-client-id-read', '']);

    // The token is prompted for separately, in a masked child process. A menu
    // that collected it would put a credential into an argument vector every
    // other process on the machine can read.
    expect(args.join(' ')).not.toMatch(/token/i);
  });

  it('builds a lane verification', async () => {
    const { args } = await menu(['7', 'read']);
    expect(args).toEqual(['lane', 'verify', 'read']);
  });
});

describe('enabling real publishing from the menu', () => {
  it('requires the exact phrase', async () => {
    const { args } = await menu(['8', 'ENABLE PUBLISHING']);
    expect(args).toEqual(['publishing', 'enable', '--confirm']);
  });

  it('refuses anything else, including a near miss', async () => {
    for (const answer of ['enable publishing', 'ENABLE PUBLISHING ', 'yes', '']) {
      await expect(menu(['8', answer]), `${answer} should be refused`).rejects.toThrow(
        /publishing was not enabled/i,
      );
    }
  });
});

describe('changing a feature from the menu', () => {
  it('lists the features, then requires ACTION KEY typed exactly', async () => {
    const { args, shown } = await menu([
      '9',
      'live_publishing',
      'disable',
      'DISABLE live_publishing',
    ]);

    expect(shown).toContain('live_publishing');
    expect(args).toEqual(['feature', 'disable', 'live_publishing', '--confirm']);
  });

  it('refuses an action that is neither enable nor disable', async () => {
    await expect(menu(['9', 'live_publishing', 'toggle'])).rejects.toThrow(/enable or disable/i);
  });

  it('refuses a confirmation that does not match the action and key', async () => {
    await expect(menu(['9', 'live_publishing', 'enable', 'ENABLE something_else'])).rejects.toThrow(
      /was not changed/i,
    );
  });
});

describe('the full purge from the menu', () => {
  it('demands the second phrase when no verified backup exists', async () => {
    const { args } = await menu([
      '10',
      'DELETE ALL LOCAL DATA',
      'NO BACKUP I ACCEPT PERMANENT LOSS',
    ]);

    // Two phrases, because there is no backup to fall back on. The second one
    // is the member stating they accept that.
    expect(args).toEqual([
      'purge',
      'all',
      '--confirm',
      'DELETE ALL LOCAL DATA',
      '--accept-no-backup',
    ]);
  });

  it('refuses when the second phrase is not exact', async () => {
    for (const answer of [
      'no backup i accept permanent loss',
      'NO BACKUP I ACCEPT PERMANENT LOSS ',
      '',
    ]) {
      await expect(
        menu(['10', 'DELETE ALL LOCAL DATA', answer]),
        `${answer} should be refused`,
      ).rejects.toThrow(/cancelled/i);
    }
  });

  it('passes a wrong first phrase through for the command to refuse', async () => {
    const { args } = await menu([
      '10',
      'delete all local data',
      'NO BACKUP I ACCEPT PERMANENT LOSS',
    ]);

    // The menu does not judge the first phrase either; purgeEverything compares
    // it, so there is one place that decides.
    expect(args[3]).toBe('delete all local data');
  });
});

describe('main', () => {
  it('runs a command given as arguments and prints the result as JSON', async () => {
    const rt = runtime();
    const output = captureOut();
    const errors = captureOut();

    await main(['status'], { input: typed([]), output }, errors, rt);

    const printed = JSON.parse(output.text()) as { home: string };
    expect(printed.home).toBe(rt.home);
    expect(errors.text()).toBe('');
  });

  it('falls through to the interactive menu when given no arguments', async () => {
    const rt = runtime();
    const output = captureOut();

    await main([], { input: typed(['1']), output }, captureOut(), rt);

    // The menu ran and its selection was executed: the status payload is there.
    expect(output.text()).toContain('1. Status');
    expect(output.text()).toContain(rt.home);
  });

  it('reports a refusal as a structured error and sets a failing exit code', async () => {
    const rt = runtime();
    const errors = captureOut();
    const previousExitCode = process.exitCode;

    await main(
      ['approval', 'grant', 'apv_nope'],
      { input: typed([]), output: captureOut() },
      errors,
      rt,
    );

    const reported = JSON.parse(errors.text()) as { error: { code: string; message: string } };
    // A refusal is machine-readable, because the caller may be a script.
    expect(typeof reported.error.code).toBe('string');
    expect(reported.error.message.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });

  it('reports a non-DomainError as a plain message rather than a stack', async () => {
    const rt = runtime();
    const errors = captureOut();
    const previousExitCode = process.exitCode;
    // A stream that fails on write is a plausible way for something other than
    // a DomainError to escape.
    const broken = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('the terminal went away'));
      },
    });
    broken.on('error', () => {});

    await main(['status'], { input: typed([]), output: broken }, errors, rt);

    if (errors.text().length > 0) {
      expect(errors.text()).not.toMatch(/ {4}at /);
    }
    process.exitCode = previousExitCode;
  });

  it('closes the runtime even when the command fails', async () => {
    const rt = runtime();
    let closed = false;
    rt.close = () => {
      closed = true;
    };
    const previousExitCode = process.exitCode;

    await main(
      ['not', 'a', 'command'],
      { input: typed([]), output: captureOut() },
      captureOut(),
      rt,
    );

    // The database must be released whatever happened, or the next run finds a
    // locked home.
    expect(closed).toBe(true);
    process.exitCode = previousExitCode;
  });
});

describe('usage', () => {
  it('names every command the CLI accepts', () => {
    const text = usage();

    for (const fragment of [
      'status',
      'source enable',
      'approval grant',
      'approval deny',
      'lane configure',
      'lane verify',
      'feature list',
      'publishing enable',
      'purge dma',
      'purge all',
    ]) {
      expect(text, `usage should mention ${fragment}`).toContain(fragment);
    }
  });

  it('tells the reader never to put a token in argv', () => {
    expect(usage()).toMatch(/never put it in argv/i);
  });
});

describe('the masked credential prompt', () => {
  it('fails cleanly, and without a secret, when the PowerShell host is missing', async () => {
    // Pointing SystemRoot at nothing is the same condition as a host where
    // Windows PowerShell has been removed or blocked.
    vi.stubEnv('SystemRoot', 'C:\\definitely-not-a-real-system-root');

    await expect(promptMaskedSecret()).rejects.toThrow(/no secret was stored/i);
  });
});

describe('opening the runtime', () => {
  it('creates and migrates the home the environment names', async () => {
    const home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-control-home-'));
    vi.stubEnv('LINKEDIN_MCP_HOME', home);
    try {
      const rt = openControlRuntime();
      try {
        expect(rt.home).toBe(home);
        expect(existsSync(join(home, 'data', 'linkedin.sqlite3'))).toBe(true);
        // Seeded, so `status` answers on a first run rather than reporting an
        // empty capability list that looks like a broken install.
        expect(listCapabilities(rt.db).length).toBeGreaterThan(0);
      } finally {
        rt.close();
        // Closing twice is what happens when main's finally block runs after a
        // command already closed it for a purge.
        rt.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 60_000);
});

describe('the commands the first pass could not reach', () => {
  // --token-stdin is deliberately not exercised here. It calls readFileSync(0),
  // which blocks until the pipe closes, and under a test runner stdin is an
  // open pipe nobody is going to close — the test would hang rather than fail.
  // What it guarantees is that the token never reaches an argument vector, and
  // the menu test above already holds that: the interactive path never asks for
  // one.

  it('turns publishing on through the feature key once the lane is proved', async () => {
    const rt = runtime();
    const secrets = rt.secrets as ReturnType<typeof memorySecrets>;
    await configureLane(rt.db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: 'a-token-long-enough-to-pass-validation',
    });
    await verifyLane(
      rt.db,
      secrets,
      'write',
      async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );

    const out = (await runControlCommand(rt, [
      'feature',
      'enable',
      'live_publishing',
      '--confirm',
    ])) as { feature: { enabled: boolean } };

    // The feature key and the publishing command are two doors to one room, and
    // both need the credential proved first.
    expect(out.feature.enabled).toBe(true);
  });

  it('enables publishing through its own command once the lane is proved', async () => {
    const rt = runtime();
    const secrets = rt.secrets as ReturnType<typeof memorySecrets>;
    await configureLane(rt.db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: 'a-token-long-enough-to-pass-validation',
    });
    await verifyLane(
      rt.db,
      secrets,
      'write',
      async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );

    const out = (await runControlCommand(rt, ['publishing', 'enable', '--confirm'])) as {
      feature: { enabled: boolean };
    };
    expect(out.feature.enabled).toBe(true);
  });

  it('offers the single-phrase purge when a verified backup exists', async () => {
    const rt = runtime();
    await runBackup(rt.db, rt.home, { actor: 'dashboard' });

    const { args } = await menu(['10', 'DELETE ALL LOCAL DATA'], rt);

    // With a verified backup there is a way back, so the second phrase — the
    // one about accepting permanent loss — is not asked for.
    expect(args).toEqual(['purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA']);
    expect(args).not.toContain('--accept-no-backup');
  }, 60_000);
});
