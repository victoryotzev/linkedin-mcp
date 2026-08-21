import { afterEach, describe, expect, it } from 'vitest';
import {
  configureLane,
  disablePublishing,
  enablePublishing,
  laneAccount,
  laneToken,
  listCapabilities,
  tokenSecretName,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The capability ladder.
//
// Nothing reaches LinkedIn until a credential has been stored, proved against
// LinkedIn by a live probe, and then separately and explicitly turned on. Each
// rung exists because the one below it proves less than it appears to: a stored
// token proves only that someone pasted a string, and a working token proves
// only that it works — not that the member decided to post with it.
//
// verifyLane takes the probe as an argument, so the domain never builds an HTTP
// client and every one of these outcomes is reachable without a network.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
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

function lanes(label = 'lane-ladder') {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  seedHealthy(fixture);
  return { fixture, db: fixture.db, secrets: memorySecrets() };
}

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

const ok =
  (extra: { person_urn?: string; warnings?: string[] } = {}) =>
  async () => ({ ok: true as const, ...extra });
const fails =
  (status: number, message = 'nope', retryable?: boolean) =>
  async () => ({
    ok: false as const,
    status,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  });

describe('storing a credential', () => {
  it('refuses something that is obviously not a token', async () => {
    const { db, secrets } = lanes();

    for (const token of ['', '   ', 'short', 'x'.repeat(19)]) {
      await expect(
        configureLane(db, secrets, { lane: 'read', client_id: 'cid', access_token: token }),
        `${JSON.stringify(token)} should be refused`,
      ).rejects.toThrow(/access token/i);
    }
  });

  it('requires a client id, so two lanes can be told apart', async () => {
    const { db, secrets } = lanes();

    await expect(
      configureLane(db, secrets, { lane: 'read', client_id: '  ', access_token: TOKEN }),
    ).rejects.toThrow(/client_id/i);
  });

  it('stores the token out of the database and marks the lane configured, not verified', async () => {
    const { db, secrets } = lanes();

    const account = await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'test-client-id-read',
      access_token: TOKEN,
    });

    // Configured means a string was pasted. It is deliberately not verified:
    // nothing has been sent to LinkedIn yet.
    expect(account.status).not.toBe('verified');
    expect(account.has_token).toBe(true);
    // And the token itself is nowhere in the row.
    expect(JSON.stringify(account)).not.toContain(TOKEN);
    expect(await secrets.get(tokenSecretName('read'))).toBe(TOKEN);
  });

  it('records an expiry when one is given', async () => {
    const { db, secrets } = lanes();

    const account = await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
      expires_in_seconds: 3600,
    });

    expect(account.token_expires_at).toBeTruthy();
    expect(new Date(account.token_expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('reading a lane token', () => {
  it('refuses when no token was ever stored', async () => {
    const { db, secrets } = lanes();
    await expect(laneToken(db, secrets, 'read')).rejects.toThrow(/no token stored/i);
  });

  it('refuses an expired token and closes the lane', async () => {
    const { db, secrets } = lanes();
    await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
      expires_in_seconds: -1,
    });

    await expect(laneToken(db, secrets, 'read')).rejects.toThrow(/expired/i);
    // Demoted, not merely refused. The demotion lands on the capabilities,
    // which is what requireCapability reads — leaving those open would let the
    // next call try anyway. The account row keeps recording what was
    // configured, which is a different question from what has been proved.
    expect(
      listCapabilities(db).some(
        (c) => c.status === 'expired' || c.blockers.includes('token_expired'),
      ),
    ).toBe(true);
  });

  it('refuses when the row says there is a token but the vault has lost it', async () => {
    const { db, secrets } = lanes();
    await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
    });
    await secrets.remove(tokenSecretName('read'));

    // A secrets folder copied from another machine looks exactly like this.
    await expect(laneToken(db, secrets, 'read')).rejects.toThrow(/could not be read/i);
  });
});

describe('proving a credential against LinkedIn', () => {
  it('verifies the lane and the capabilities the probe covers', async () => {
    const { db, secrets } = lanes();
    await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
    });

    const result = await verifyLane(db, secrets, 'read', ok(), 'dashboard');

    expect(laneAccount(db, 'read').status).toBe('verified');
    expect(result.verified.length).toBeGreaterThan(0);
  });

  it('records the person URN a write-lane probe returns', async () => {
    const { db, secrets } = lanes();
    await configureLane(db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });

    const result = await verifyLane(
      db,
      secrets,
      'write',
      ok({ person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );

    // Publishing needs an author. Without this the lane can be verified and
    // still be unable to post.
    expect(result.person_urn).toBe('urn:li:person:fixture');
    expect(laneAccount(db, 'write').person_urn).toBe('urn:li:person:fixture');
  });

  it('reports warnings from a probe that succeeded without opening the lane', async () => {
    const { db, secrets } = lanes();
    await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
    });

    const result = await verifyLane(
      db,
      secrets,
      'read',
      ok({ warnings: ['no member data portability product on this app'] }),
      'dashboard',
    );

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('leaves the lane untouched when the probe could not complete', async () => {
    const { db, secrets } = lanes();
    await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
    });
    await verifyLane(db, secrets, 'read', ok(), 'dashboard');
    expect(laneAccount(db, 'read').status).toBe('verified');

    await expect(
      verifyLane(db, secrets, 'read', fails(0, 'connection reset', true), 'dashboard'),
    ).rejects.toThrow(/try again/i);

    // A dropped connection or a 429 is not evidence about the credential.
    // Demoting on one would close a working lane until a human re-verified it.
    expect(laneAccount(db, 'read').status).toBe('verified');
  });

  it('demotes to expired on a 401 and to revoked on a 403, because the remedies differ', async () => {
    for (const [status, expected] of [
      [401, 'expired'],
      [403, 'revoked'],
      [500, 'blocked'],
    ] as const) {
      const { db, secrets } = lanes(`lane-demote-${status}`);
      await configureLane(db, secrets, {
        lane: 'read',
        client_id: 'cid-read',
        access_token: TOKEN,
      });

      await expect(verifyLane(db, secrets, 'read', fails(status), 'dashboard')).rejects.toThrow(
        new RegExp(String(status)),
      );
      // The demotion state differs by cause because the remedy differs: an
      // expired token is re-minted, a revoked product is re-requested.
      const readCapabilities = listCapabilities(db).filter((c) =>
        c.feature.startsWith('linkedin.dma'),
      );
      expect(
        readCapabilities.some((c) => c.status === expected),
        `HTTP ${status} should demote to ${expected}`,
      ).toBe(true);
    }
  });

  it('refuses to verify a lane that was never configured', async () => {
    const { db, secrets } = lanes();

    // No row at all is a different situation from a row with no token, and it
    // says so: there is no LinkedIn application yet.
    await expect(verifyLane(db, secrets, 'write', ok(), 'dashboard')).rejects.toThrow(
      /no write lane configured/i,
    );
  });
});

describe('turning publishing on', () => {
  async function provenWriteLane(label: string) {
    const { db, secrets } = lanes(label);
    await configureLane(db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await verifyLane(
      db,
      secrets,
      'write',
      ok({ person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );
    return { db, secrets };
  }

  it('refuses without an explicit confirmation', async () => {
    const { db } = await provenWriteLane('publish-enable-unconfirmed');
    expect(() => enablePublishing(db, false, 'dashboard')).toThrow(/explicit decision/i);
  });

  it('refuses while the credential has never been proved', async () => {
    const { db, secrets } = lanes('publish-enable-unproven');
    await configureLane(db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });

    // configureLane sets 'configured' the moment a string is pasted. Gating on
    // that alone would promote a never-probed credential straight to verified,
    // which is the one thing the fail-closed model exists to prevent.
    expect(() => enablePublishing(db, true, 'dashboard')).toThrow(/never proved|verify/i);
  });

  it('refuses when nothing has been configured at all', () => {
    const { db } = lanes('publish-enable-nothing');
    expect(() => enablePublishing(db, true, 'dashboard')).toThrow(/verify the publishing lane/i);
  });

  it('turns publishing on once the write lane has been proved', async () => {
    const { db } = await provenWriteLane('publish-enable-ok');

    const result = enablePublishing(db, true, 'dashboard');

    expect(result.status).toBe('verified');
    expect(listCapabilities(db, 'linkedin.publish_post')[0]?.status).toBe('verified');
  });

  it('is idempotent once on', async () => {
    const { db } = await provenWriteLane('publish-enable-twice');
    enablePublishing(db, true, 'dashboard');

    expect(enablePublishing(db, true, 'dashboard').status).toBe('verified');
  });

  it('turns off and back on again', async () => {
    const { db } = await provenWriteLane('publish-toggle');
    enablePublishing(db, true, 'dashboard');

    disablePublishing(db, true, 'dashboard');
    expect(listCapabilities(db, 'linkedin.publish_post')[0]?.status).not.toBe('verified');

    // Re-enabling after an explicit disable does not require re-proving the
    // credential; it was proved, and the member only turned it off.
    expect(enablePublishing(db, true, 'dashboard').status).toBe('verified');
  });

  it('refuses to turn off without a confirmation', async () => {
    const { db } = await provenWriteLane('publish-disable-unconfirmed');
    enablePublishing(db, true, 'dashboard');

    expect(() => disablePublishing(db, false, 'dashboard')).toThrow();
  });
});

describe('proving the read lane does not open the write lane', () => {
  it('leaves publishing shut', async () => {
    const { db, secrets } = lanes('lane-isolation');
    await configureLane(db, secrets, {
      lane: 'read',
      client_id: 'cid-read',
      access_token: TOKEN,
    });
    await verifyLane(db, secrets, 'read', ok(), 'dashboard');

    // The two lanes are separate LinkedIn applications. A verified read lane
    // saying anything at all about publishing would be a category error.
    expect(() => laneAccount(db, 'write')).toThrow(/no write lane configured/i);
    expect(listCapabilities(db, 'linkedin.publish_post')[0]?.status).not.toBe('verified');
    expect(() => enablePublishing(db, true, 'dashboard')).toThrow();
  });
});

describe('states the ladder should never be in', () => {
  it('refuses a publishing capability marked verified over an unverified account', async () => {
    const { db, secrets } = lanes('publish-mismatch');
    await configureLane(db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    // Only reachable by editing the database directly, which is the point: the
    // capability row and the account row are two records of one fact, and a
    // publish path that trusted the capability alone would post on a credential
    // nothing ever proved.
    db.run(
      "UPDATE capabilities SET status = 'verified', blockers_json = '[]' WHERE feature = 'linkedin.publish_post'",
    );

    expect(() => enablePublishing(db, true, 'dashboard')).toThrow(/not verified/i);
  });

  it('refuses to enable when the probe came back with warnings', async () => {
    const { db, secrets } = lanes('publish-warned');
    await configureLane(db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await verifyLane(
      db,
      secrets,
      'write',
      async () => ({ ok: true, warnings: ['w_member_not_in_eea'] }),
      'dashboard',
    );

    // The token works — LinkedIn answered — but the lane cannot deliver, so
    // the capability holds at configured carrying the warning rather than the
    // awaiting_explicit_enable that a clean probe writes. Enabling here would
    // promote a lane that is known not to work.
    expect(() => enablePublishing(db, true, 'dashboard')).toThrow(/never proved|verification/i);
    expect(listCapabilities(db, 'linkedin.publish_post')[0]?.blockers).toContain(
      'w_member_not_in_eea',
    );
  });

  it('refuses to disable a capability that is not registered', () => {
    const { db } = lanes('publish-unregistered');
    db.run("DELETE FROM capabilities WHERE feature = 'linkedin.publish_post'");

    // Reporting success here would tell the member publishing is off when the
    // row that answers that question does not exist.
    expect(() => disablePublishing(db, true, 'dashboard')).toThrow(/not registered/i);
  });
});
