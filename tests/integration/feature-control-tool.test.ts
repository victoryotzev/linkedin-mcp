import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureLane,
  getFeatureControl,
  listCapabilities,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Turning a feature on and off through the MCP tool.
//
// Eight of the nine switches are presentation: they decide which tools a host
// sees. The ninth is not. `live_publishing` is the second gate in front of the
// member's public profile, so the tool cannot treat it as a settings row — it
// has to route through the same enable/disable that the dashboard uses, which
// refuses unless a credential has actually been proved against LinkedIn.

let fixture: Fixture;
let secrets: SecretStore;
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

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

beforeEach(() => {
  fixture = createFixture('feature-control-tool');
  seedHealthy(fixture);
  secrets = memorySecrets();
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

interface FeatureList {
  features: Array<{ key: string; enabled: boolean; default_enabled: boolean; title: string }>;
}

const featureOf = (out: FeatureList, key: string) => out.features.find((f) => f.key === key);

/** Stores and proves a write-lane credential, without a network. */
async function proveWriteLane(): Promise<void> {
  await configureLane(fixture.db, secrets, {
    lane: 'write',
    client_id: 'cid-write',
    access_token: TOKEN,
  });
  await verifyLane(
    fixture.db,
    secrets,
    'write',
    async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
    'dashboard',
  );
}

describe('listing the switches', () => {
  it('answers with every feature, its title and whether it is on', async () => {
    const out = (await call('linkedin_feature_control', { action: 'list' })) as FeatureList;

    expect(out.features).toHaveLength(9);
    for (const feature of out.features) {
      expect(feature.title, feature.key).toBeTruthy();
      expect(typeof feature.enabled, feature.key).toBe('boolean');
    }
  });

  it('starts with publishing off and the read-side features on', async () => {
    const out = (await call('linkedin_feature_control', { action: 'list' })) as FeatureList;

    // The default has to be off: everything else here is a view, and this one
    // posts.
    expect(featureOf(out, 'live_publishing')?.enabled).toBe(false);
    expect(featureOf(out, 'evidence')?.enabled).toBe(true);
  });
});

describe('setting an ordinary switch', () => {
  it('turns one off and reports the new state', async () => {
    const out = (await call('linkedin_feature_control', {
      action: 'set',
      feature: 'analytics',
      enabled: false,
      confirm: true,
    })) as FeatureList;

    expect(featureOf(out, 'analytics')?.enabled).toBe(false);
    expect(getFeatureControl(fixture.db, 'analytics').enabled).toBe(false);
    // Turning one off leaves the others alone.
    expect(featureOf(out, 'evidence')?.enabled).toBe(true);
  });

  it('turns it back on', async () => {
    await call('linkedin_feature_control', {
      action: 'set',
      feature: 'analytics',
      enabled: false,
      confirm: true,
    });

    const out = (await call('linkedin_feature_control', {
      action: 'set',
      feature: 'analytics',
      enabled: true,
      confirm: true,
    })) as FeatureList;

    expect(featureOf(out, 'analytics')?.enabled).toBe(true);
  });

  it('does nothing at all when the switch is already where it is asked to be', async () => {
    const before = fixture.db.get('SELECT COUNT(*) AS n FROM audit_events')?.['n'];

    const out = (await call('linkedin_feature_control', {
      action: 'set',
      feature: 'evidence',
      enabled: true,
      confirm: true,
    })) as FeatureList;

    expect(featureOf(out, 'evidence')?.enabled).toBe(true);
    // A no-op that still wrote to the log would fill the hash chain with
    // events that record no change, and the log is what the member reads to
    // find out what happened.
    expect(fixture.db.get('SELECT COUNT(*) AS n FROM audit_events')?.['n']).toBe(before);
  });

  it('refuses a switch it does not have', async () => {
    await expect(
      call('linkedin_feature_control', {
        action: 'set',
        feature: 'delete_everything',
        enabled: true,
        confirm: true,
      }),
    ).rejects.toBeTruthy();
  });

  it('refuses to set anything without a confirmation', async () => {
    await expect(
      call('linkedin_feature_control', { action: 'set', feature: 'analytics', enabled: false }),
    ).rejects.toBeTruthy();
  });
});

describe('the publishing switch, which is not an ordinary switch', () => {
  it('refuses to turn on while no credential has been proved', async () => {
    await expect(
      call('linkedin_feature_control', {
        action: 'set',
        feature: 'live_publishing',
        enabled: true,
        confirm: true,
      }),
    ).rejects.toThrow(/verify the publishing lane|never proved/i);

    // And the settings row is untouched, so a refused enable cannot leave the
    // switch reading 'on' with the capability still shut.
    expect(getFeatureControl(fixture.db, 'live_publishing').enabled).toBe(false);
  });

  it('opens the capability, not just the switch, once the lane is proved', async () => {
    await proveWriteLane();

    const out = (await call('linkedin_feature_control', {
      action: 'set',
      feature: 'live_publishing',
      enabled: true,
      confirm: true,
    })) as FeatureList;

    expect(featureOf(out, 'live_publishing')?.enabled).toBe(true);
    // Both, because the tool list is what a host sees and the capability is
    // what the publish path checks. One without the other is a switch that
    // lies in one direction or the other.
    expect(listCapabilities(fixture.db, 'linkedin.publish_post')[0]?.status).toBe('verified');
  });

  it('closes the capability again when it is turned off', async () => {
    await proveWriteLane();
    await call('linkedin_feature_control', {
      action: 'set',
      feature: 'live_publishing',
      enabled: true,
      confirm: true,
    });

    const out = (await call('linkedin_feature_control', {
      action: 'set',
      feature: 'live_publishing',
      enabled: false,
      confirm: true,
    })) as FeatureList;

    expect(featureOf(out, 'live_publishing')?.enabled).toBe(false);
    expect(listCapabilities(fixture.db, 'linkedin.publish_post')[0]?.status).not.toBe('verified');
  });

  it('turns back on after an explicit disable without re-proving anything', async () => {
    await proveWriteLane();
    for (const enabled of [true, false, true]) {
      await call('linkedin_feature_control', {
        action: 'set',
        feature: 'live_publishing',
        enabled,
        confirm: true,
      });
    }

    // The credential was proved and the member only changed their mind; making
    // them re-mint a token to undo a toggle would teach them to leave it on.
    expect(listCapabilities(fixture.db, 'linkedin.publish_post')[0]?.status).toBe('verified');
  });
});
