import { afterEach, describe, expect, it } from 'vitest';
import type { SecretStore } from '@linkedin-mcp/domain';
import { runControlCommand, type ControlRuntime } from '../../scripts/control.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function runtime(fixture: Fixture, secrets: SecretStore): ControlRuntime {
  return {
    db: fixture.db,
    home: fixture.dir,
    secrets,
    close() {},
  };
}

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

describe('human control CLI', () => {
  it('lists feature descriptions and changes the shared feature policy', async () => {
    const fixture = createFixture('control-features');
    fixtures.push(fixture);
    const control = runtime(fixture, memorySecrets());

    const listed = (await runControlCommand(control, ['feature', 'list'])) as {
      features: Array<{ key: string; description: string; enabled: boolean }>;
    };
    expect(listed.features.find((feature) => feature.key === 'live_publishing')?.enabled).toBe(
      false,
    );
    expect(listed.features.every((feature) => feature.description.length > 20)).toBe(true);
    await expect(
      runControlCommand(control, ['feature', 'disable', 'analytics']),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await runControlCommand(control, ['feature', 'disable', 'analytics', '--confirm']);

    const status = (await runControlCommand(control, ['status'])) as {
      features: Array<{ key: string; enabled: boolean }>;
    };
    expect(status.features.find((feature) => feature.key === 'analytics')?.enabled).toBe(false);
  });

  it('enables sources and grants publication approval as an audited human actor', async () => {
    const fixture = createFixture('control-authority');
    fixtures.push(fixture);
    const seeded = seedHealthy(fixture);
    const control = runtime(fixture, memorySecrets());

    await runControlCommand(control, ['source', 'enable', seeded.pendingSourceId]);
    await expect(
      runControlCommand(control, ['approval', 'grant', seeded.approvalId]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const revisionHash = String(
      fixture.db.get('SELECT revision_hash FROM approvals WHERE id = ?', seeded.approvalId)?.[
        'revision_hash'
      ],
    );
    await runControlCommand(control, [
      'approval',
      'grant',
      seeded.approvalId,
      '--revision-hash',
      revisionHash,
    ]);

    expect(
      fixture.db.get('SELECT status FROM sources WHERE id = ?', seeded.pendingSourceId),
    ).toMatchObject({
      status: 'enabled',
    });
    expect(
      fixture.db.get('SELECT state FROM approvals WHERE id = ?', seeded.approvalId),
    ).toMatchObject({
      state: 'granted',
    });
    const actors = fixture.db
      .all("SELECT actor FROM audit_events WHERE actor = 'human_cli'")
      .map((row) => row['actor']);
    expect(actors.length).toBeGreaterThanOrEqual(2);
  });

  it('configures a lane without putting the credential in command arguments or output', async () => {
    const fixture = createFixture('control-secret');
    fixtures.push(fixture);
    const secrets = memorySecrets();
    const token = 'sensitive-token-value-that-is-long-enough';

    const result = await runControlCommand(
      runtime(fixture, secrets),
      ['lane', 'configure', 'read', '--client-id', 'client-123'],
      async () => token,
    );

    expect(secrets.values.get('linkedin.access_token.read')).toBe(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(
      fixture.db.get("SELECT client_id FROM linkedin_accounts WHERE lane = 'read'"),
    ).toMatchObject({
      client_id: 'client-123',
    });
  });
});
