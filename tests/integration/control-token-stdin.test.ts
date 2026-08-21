import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStore } from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Storing a credential from a pipe.
//
// The CLI's whole point is that a token never enters argv, where every process
// on the machine can read it. `--token-stdin` is the scripted equivalent of the
// masked prompt: the caller pipes the token in and the command reads file
// descriptor 0. That read blocks forever under a test runner, which has no
// terminal and no pipe on 0, so the descriptor is what is stood in for here —
// everything after it is the real path into the real vault interface.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) => {
      if (target === 0) return `  ${pipedToken}\n`;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(target, ...rest);
    },
  };
});

let pipedToken = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

const { runControlCommand } = await import('../../scripts/control.ts');

let fixture: Fixture;
let stored: Map<string, string>;

function memorySecrets(): SecretStore {
  stored = new Map<string, string>();
  return {
    async put(name, value) {
      stored.set(name, value);
    },
    async get(name) {
      return stored.get(name) ?? null;
    },
    has(name) {
      return stored.has(name);
    },
    listNames() {
      return [...stored.keys()].sort();
    },
    async remove(name) {
      stored.delete(name);
    },
  };
}

function runtime(): Parameters<typeof runControlCommand>[0] {
  return {
    db: fixture.db,
    home: fixture.dir,
    secrets: memorySecrets(),
    close() {},
  } as Parameters<typeof runControlCommand>[0];
}

beforeEach(() => {
  pipedToken = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';
  fixture = createFixture('control-token-stdin');
  seedHealthy(fixture);
});

afterEach(() => fixture.close());

describe('lane configure --token-stdin', () => {
  it('reads the token from the pipe and never asks the prompt', async () => {
    let prompted = 0;

    const out = (await runControlCommand(
      runtime(),
      ['lane', 'configure', 'read', '--client-id', 'cid-read', '--token-stdin'],
      async () => {
        prompted += 1;
        return 'the prompt should not have run';
      },
    )) as { account: { lane: string } };

    expect(prompted).toBe(0);
    expect(out.account.lane).toBe('read');
    // Stored, and stored trimmed: a piped token routinely arrives with a
    // trailing newline, which becomes an invalid Authorization header hours
    // later and reads exactly like a revoked credential.
    expect(stored.get('linkedin.access_token.read')).toBe(
      'AQV-fake-fixture-token-not-a-real-credential-0123456789',
    );
  }, 60_000);

  it('refuses a piped value that is obviously not a token', async () => {
    pipedToken = 'nope';

    await expect(
      runControlCommand(
        runtime(),
        ['lane', 'configure', 'read', '--client-id', 'cid-read', '--token-stdin'],
        async () => 'unused',
      ),
    ).rejects.toBeTruthy();

    // Nothing stored: a pipe is not a reason to relax what counts as a token.
    expect(stored.size).toBe(0);
  }, 60_000);

  it('still asks the prompt when the flag is absent', async () => {
    let prompted = 0;

    await runControlCommand(
      runtime(),
      ['lane', 'configure', 'read', '--client-id', 'cid-read'],
      async () => {
        prompted += 1;
        return 'AQV-fake-fixture-token-not-a-real-credential-0123456789';
      },
    );

    expect(prompted).toBe(1);
  }, 60_000);
});
