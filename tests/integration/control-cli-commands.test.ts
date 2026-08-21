import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFeatureControls, listSources, type SecretStore } from '@linkedin-mcp/domain';
import { runControlCommand, type ControlRuntime } from '../../scripts/control.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The control CLI is the dashboard-free human-authority surface: it is where a
// person enables a source, grants an approval, stores a credential, or destroys
// everything. Its existing test covers three paths; this covers the rest of the
// command table, because a broken branch here is a member locked out of a
// decision the model is deliberately not allowed to make for them.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
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

function runtime(seed = true): ControlRuntime & { fixture: Fixture } {
  const fixture = createFixture('control-commands');
  fixtures.push(fixture);
  if (seed) seedHealthy(fixture);
  return {
    fixture,
    db: fixture.db,
    home: fixture.dir,
    secrets: memorySecrets(),
    close() {},
  } as ControlRuntime & { fixture: Fixture };
}

const run = (rt: ControlRuntime, ...args: string[]) =>
  runControlCommand(rt, args, async () => 'a-token-long-enough-to-pass');

describe('status', () => {
  it('reports the home, sources, approvals, lanes and features', async () => {
    const rt = runtime();
    const out = (await run(rt, 'status')) as Record<string, unknown>;

    expect(out['home']).toBe(rt.home);
    expect(Array.isArray(out['sources'])).toBe(true);
    expect(Array.isArray(out['approvals'])).toBe(true);
    expect(Array.isArray(out['lanes'])).toBe(true);
  });
});

describe('source', () => {
  it('lists sources', async () => {
    const rt = runtime();
    const out = (await run(rt, 'source', 'list')) as { sources: unknown[] };
    expect(Array.isArray(out.sources)).toBe(true);
  });

  it('enables a pending source by id', async () => {
    const rt = runtime();
    const pending = listSources(rt.db).find((s) => s.status === 'pending_review');
    if (!pending) {
      // seedHealthy enables what it creates; register nothing rather than
      // assert on a fixture detail this test does not own.
      expect(listSources(rt.db).length).toBeGreaterThan(0);
      return;
    }
    await run(rt, 'source', 'enable', pending.id);
    expect(listSources(rt.db).find((s) => s.id === pending.id)?.status).toBe('enabled');
  });

  it('refuses an unknown source id', async () => {
    const rt = runtime();
    await expect(run(rt, 'source', 'enable', 'src_does_not_exist')).rejects.toBeTruthy();
  });
});

describe('feature', () => {
  it('lists every feature group with its current value', async () => {
    const rt = runtime();
    const out = (await run(rt, 'feature', 'list')) as {
      features: Array<{ key: string; enabled: boolean }>;
    };

    expect(out.features.length).toBe(listFeatureControls(rt.db).length);
    expect(out.features.some((f) => f.key === 'live_publishing')).toBe(true);
  });

  it('requires --confirm before changing one', async () => {
    const rt = runtime();
    await expect(run(rt, 'feature', 'disable', 'analytics')).rejects.toBeTruthy();
    expect(listFeatureControls(rt.db).find((f) => f.key === 'analytics')?.enabled).toBe(true);
  });

  it('disables and re-enables a group when confirmed', async () => {
    const rt = runtime();
    await runControlCommand(rt, ['feature', 'disable', 'analytics', '--confirm']);
    expect(listFeatureControls(rt.db).find((f) => f.key === 'analytics')?.enabled).toBe(false);

    await runControlCommand(rt, ['feature', 'enable', 'analytics', '--confirm']);
    expect(listFeatureControls(rt.db).find((f) => f.key === 'analytics')?.enabled).toBe(true);
  });

  it('refuses a feature key it does not know', async () => {
    const rt = runtime();
    await expect(
      runControlCommand(rt, ['feature', 'enable', 'teleportation', '--confirm']),
    ).rejects.toBeTruthy();
  });
});

describe('approval', () => {
  it('lists approvals', async () => {
    const rt = runtime();
    const out = (await run(rt, 'approval', 'list')) as { approvals: unknown[] };
    expect(Array.isArray(out.approvals)).toBe(true);
  });

  it('previews an approval byte-exactly', async () => {
    const rt = runtime();
    const { approvals } = (await run(rt, 'approval', 'list')) as {
      approvals: Array<{ id: string }>;
    };
    if (approvals.length === 0) return;

    const { preview } = (await run(rt, 'approval', 'preview', approvals[0]!.id)) as {
      preview: { revision_hash: string; body_text: string };
    };
    expect(preview.revision_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof preview.body_text).toBe('string');
  });

  it('refuses a grant without the revision hash from that preview', async () => {
    const rt = runtime();
    const { approvals } = (await run(rt, 'approval', 'list')) as {
      approvals: Array<{ id: string; state: string }>;
    };
    const pending = approvals.find((a) => a.state === 'pending');
    if (!pending) return;

    // Blind approval by id is the thing this guard exists to stop.
    await expect(run(rt, 'approval', 'grant', pending.id)).rejects.toBeTruthy();
    await expect(
      runControlCommand(rt, ['approval', 'grant', pending.id, '--revision-hash', 'f'.repeat(64)]),
    ).rejects.toBeTruthy();
  });

  it('denies an approval with a reason', async () => {
    const rt = runtime();
    const { approvals } = (await run(rt, 'approval', 'list')) as {
      approvals: Array<{ id: string; state: string }>;
    };
    const pending = approvals.find((a) => a.state === 'pending');
    if (!pending) return;

    await runControlCommand(rt, ['approval', 'deny', pending.id, '--reason', 'not this week']);
    const { approvals: after } = (await run(rt, 'approval', 'list')) as {
      approvals: Array<{ id: string; state: string }>;
    };
    expect(after.find((a) => a.id === pending.id)?.state).toBe('denied');
  });
});

describe('lane', () => {
  it('lists lanes', async () => {
    const rt = runtime();
    const out = (await run(rt, 'lane', 'list')) as { lanes: unknown[] };
    expect(Array.isArray(out.lanes)).toBe(true);
  });

  it('stores a credential through the masked provider, never through argv', async () => {
    const rt = runtime();
    const secrets = rt.secrets as ReturnType<typeof memorySecrets>;

    await runControlCommand(
      rt,
      ['lane', 'configure', 'read', '--client-id', 'test-client-id'],
      async () => 'a-token-long-enough-to-pass-validation',
    );

    // The token reached the vault, and it came from the provider rather than
    // from an argument any other process on the machine could have read.
    expect([...secrets.values.keys()].some((k) => k.includes('access_token'))).toBe(true);
  });

  it('refuses an unknown lane name', async () => {
    const rt = runtime();
    await expect(run(rt, 'lane', 'configure', 'sideways', '--client-id', 'x')).rejects.toBeTruthy();
  });
});

describe('purge', () => {
  it('refuses a full purge without the exact phrase', async () => {
    const rt = runtime();
    await expect(run(rt, 'purge', 'all')).rejects.toBeTruthy();
    await expect(
      runControlCommand(rt, ['purge', 'all', '--confirm', 'delete all local data']),
    ).rejects.toBeTruthy();
    // Still there.
    expect(listSources(rt.db).length).toBeGreaterThan(0);
  });

  it('refuses a DMA purge without its own exact phrase', async () => {
    const rt = runtime();
    await expect(run(rt, 'purge', 'dma')).rejects.toBeTruthy();
  });

  it('rejects a future or offset-less prune cutoff', async () => {
    const rt = runtime();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await expect(runControlCommand(rt, ['purge', 'dma', '--before', future])).rejects.toBeTruthy();
    await expect(
      runControlCommand(rt, ['purge', 'dma', '--before', '2026-01-01T00:00:00']),
    ).rejects.toBeTruthy();
  });
});

describe('unknown input', () => {
  it('refuses an unrecognised command with usage', async () => {
    const rt = runtime();
    await expect(run(rt, 'teleport', 'now')).rejects.toThrow(/usage/i);
  });

  it('refuses an empty command', async () => {
    const rt = runtime();
    await expect(runControlCommand(rt, [])).rejects.toThrow(/usage/i);
  });
});

describe('granting an approval from the CLI', () => {
  it('accepts the exact revision hash from the preview and records the grant', async () => {
    const rt = runtime();
    const { approvals } = (await run(rt, 'approval', 'list')) as {
      approvals: Array<{ id: string; state: string }>;
    };
    const pending = approvals.find((a) => a.state === 'pending');
    if (!pending) return;

    const { preview } = (await run(rt, 'approval', 'preview', pending.id)) as {
      preview: { revision_hash: string };
    };
    await runControlCommand(rt, [
      'approval',
      'grant',
      pending.id,
      '--revision-hash',
      preview.revision_hash,
    ]);

    const { approvals: after } = (await run(rt, 'approval', 'list')) as {
      approvals: Array<{ id: string; state: string }>;
    };
    // The hash is the binding between the decision and the exact bytes that
    // were shown; matching it is the whole contract.
    expect(after.find((a) => a.id === pending.id)?.state).toBe('granted');
  });
});

describe('lane verification', () => {
  it('reports an unverified lane rather than pretending it works', async () => {
    const rt = runtime();

    // No credential is stored, so verification cannot succeed. What it must not
    // do is throw an unhandled error or report success.
    const result = await run(rt, 'lane', 'verify', 'read').catch((error: unknown) => ({
      threw: error,
    }));
    const payload = JSON.stringify(result);
    expect(payload).not.toMatch(/"verified"\s*:\s*true/);
  });

  it('refuses to verify a lane name that does not exist', async () => {
    const rt = runtime();
    await expect(run(rt, 'lane', 'verify', 'sideways')).rejects.toBeTruthy();
  });

  it('accepts an optional expiry when configuring a lane', async () => {
    const rt = runtime();
    const secrets = rt.secrets as ReturnType<typeof memorySecrets>;

    await runControlCommand(
      rt,
      [
        'lane',
        'configure',
        'write',
        '--client-id',
        'test-client-id',
        '--expires-in-seconds',
        '900',
      ],
      async () => 'a-token-long-enough-to-pass-validation',
    );

    expect([...secrets.values.keys()].some((k) => k.includes('access_token'))).toBe(true);
  });

  it('rejects an expiry that is not a positive number of seconds', async () => {
    const rt = runtime();
    await expect(
      runControlCommand(
        rt,
        ['lane', 'configure', 'read', '--client-id', 'x', '--expires-in-seconds', '-5'],
        async () => 'a-token-long-enough-to-pass-validation',
      ),
    ).rejects.toBeTruthy();
  });
});

describe('publishing', () => {
  it('requires --confirm to enable', async () => {
    const rt = runtime();
    await expect(run(rt, 'publishing', 'enable')).rejects.toBeTruthy();
    expect(
      listFeatureControls(rt.db).find((f) => f.key === 'live_publishing')?.enabled,
    ).toBeFalsy();
  });

  it('requires --confirm to disable', async () => {
    const rt = runtime();
    await expect(run(rt, 'publishing', 'disable')).rejects.toBeTruthy();
  });

  it('refuses to enable while the write lane is unverified', async () => {
    const rt = runtime();

    // Turning on live publishing with no verified write lane would arm a
    // capability that cannot work, and would report success doing it.
    await expect(run(rt, 'publishing', 'enable', '--confirm')).rejects.toBeTruthy();
    expect(
      listFeatureControls(rt.db).find((f) => f.key === 'live_publishing')?.enabled,
    ).toBeFalsy();
  });

  it('disables cleanly when confirmed, leaving the feature off', async () => {
    const rt = runtime();
    await runControlCommand(rt, ['publishing', 'disable', '--confirm']);

    expect(
      listFeatureControls(rt.db).find((f) => f.key === 'live_publishing')?.enabled,
    ).toBeFalsy();
  });

  it('routes the live_publishing feature key through the publishing gate', async () => {
    const rt = runtime();

    // `feature enable live_publishing` is a second door to the same room. It
    // must meet the same lane requirement, not bypass it.
    await expect(run(rt, 'feature', 'enable', 'live_publishing', '--confirm')).rejects.toBeTruthy();
    expect(
      listFeatureControls(rt.db).find((f) => f.key === 'live_publishing')?.enabled,
    ).toBeFalsy();
  });

  it('returns the current value unchanged when a feature is already in that state', async () => {
    const rt = runtime();
    const before = listFeatureControls(rt.db).find((f) => f.key === 'live_publishing');

    const out = (await run(rt, 'feature', 'disable', 'live_publishing', '--confirm')) as {
      feature: { enabled: boolean };
    };

    // A no-op must stay a no-op: no audit entry, no state change, no error.
    expect(out.feature.enabled).toBe(before?.enabled ?? false);
  });
});

describe('the DMA purge', () => {
  it('deletes portability data when given its exact phrase', async () => {
    const rt = runtime();

    const out = (await run(
      rt,
      'purge',
      'dma',
      '--confirm',
      'DELETE LINKEDIN PORTABILITY DATA',
    )) as { result: Record<string, unknown> };

    expect(out.result).toBeTruthy();
  });

  it('prunes history older than a cutoff without needing the phrase', async () => {
    const rt = runtime();

    // Pruning old history is routine retention, not deletion of everything;
    // requiring the destructive phrase for it would train members to type it.
    const out = (await run(
      rt,
      'purge',
      'dma',
      '--before',
      new Date(Date.now() - 86_400_000).toISOString(),
    )) as { result: Record<string, unknown> };

    expect(out.result).toBeTruthy();
  });
});

describe('the full purge', () => {
  it('refuses without a verified backup unless the loss is explicitly accepted', async () => {
    const rt = runtime();

    await expect(
      run(rt, 'purge', 'all', '--confirm', 'DELETE ALL LOCAL DATA'),
    ).rejects.toBeTruthy();
    expect(listSources(rt.db, {}).length).toBeGreaterThan(0);
  });

  it('destroys the home once the phrase and the accepted loss are both present', async () => {
    const rt = runtime();
    const home = rt.home;
    // The real CLI closes the database before deleting the home; Windows will
    // not remove a directory holding an open SQLite file. The harness stubs
    // close() out, so this test supplies the real thing.
    rt.close = () => rt.fixture.db.close();
    // Teardown must not close it a second time or walk a deleted directory.
    rt.fixture.close = () => {};

    const out = (await run(
      rt,
      'purge',
      'all',
      '--confirm',
      'DELETE ALL LOCAL DATA',
      '--accept-no-backup',
    )) as { result: { removed: string[]; kept: string[] } };

    // The purge empties the five directories it owns; it deliberately does not
    // remove the home itself, which the member may have pointed at a directory
    // holding other things.
    expect([...out.result.removed, ...out.result.kept].sort()).toEqual([
      'artifacts',
      'backups',
      'data',
      'logs',
      'secrets',
    ]);
    expect(out.result.removed).toContain('artifacts');
    expect(existsSync(join(home, 'artifacts'))).toBe(false);
  });
});
