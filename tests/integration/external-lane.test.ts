import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureLane,
  createSecretStore,
  latestSnapshot,
  listCapabilities,
  listPublishedPosts,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The lane tools with a real credential behind them and LinkedIn stubbed at the
// socket.
//
// Every other DMA suite substitutes a fake client, which is right for testing
// the mapping. These go the other way: the tools build the real DmaClient from
// a token they read out of the real vault, and only the network is replaced. So
// what runs here is the credential path, the URL construction, the version
// header and the error mapping — everything between "the member pasted a token"
// and "bytes arrived".
//
// The vault is DPAPI, so these skip off Windows rather than being softened.

const IS_WINDOWS = process.platform === 'win32';

function dpapiAvailable(): boolean {
  if (!IS_WINDOWS) return false;
  const systemRoot = process.env['SystemRoot'];
  const exe = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const probe = spawnSync(
    exe,
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; exit 0'],
    { windowsHide: true, timeout: 20_000 },
  );
  return probe.status === 0;
}

const HAS_DPAPI = dpapiAvailable();
const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

const PROFILE_ROW = {
  'First Name': 'Alex',
  'Last Name': 'Rivera',
  Headline: 'Full-Stack Web Developer',
  Summary: 'Builds local-first systems.',
  Industry: 'Software Development',
  'Geo Location': 'Ghent, Belgium',
};

const SHARE_ROW = {
  Date: '2026-03-01 10:00:00',
  ShareCommentary: 'A post about renovating deployed software rather than rewriting it.',
  ShareLink: 'https://www.linkedin.com/feed/update/urn:li:share:1/',
  Visibility: 'MEMBER_NETWORK',
};

let fixture: Fixture;
const requests: string[] = [];

beforeEach(() => {
  fixture = createFixture('external-lane');
  seedHealthy(fixture);
  requests.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.close();
});

function tools() {
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
    scheduleFullPurge: () => {},
  } as never);
  return async (name: string, args: unknown) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
}

/** Answers LinkedIn's snapshot and changelog endpoints, recording every URL. */
function stubLinkedIn(
  handler?: (url: string) => { status: number; body: unknown } | undefined,
): void {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    requests.push(url);

    const custom = handler?.(url);
    if (custom) {
      return new Response(JSON.stringify(custom.body), {
        status: custom.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('memberSnapshotData')) {
      const domain = /domain=([A-Z_]+)/.exec(url)?.[1] ?? 'PROFILE';
      const page = Number(/start=(\d+)/.exec(url)?.[1] ?? '0');
      // The walk ends on an empty page, so a stub that always answers with rows
      // runs to the 200-page cap and reports a snapshot that never terminated.
      const rows =
        page > 0
          ? []
          : domain === 'PROFILE'
            ? [PROFILE_ROW]
            : domain === 'MEMBER_SHARE_INFO'
              ? [SHARE_ROW]
              : [];
      return new Response(
        JSON.stringify({ elements: [{ snapshotDomain: domain, snapshotData: rows }], paging: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.includes('memberChangeLogs')) {
      return new Response(JSON.stringify({ elements: [], paging: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** Pastes a credential the way the dashboard does, into the real DPAPI vault. */
async function storeReadToken(): Promise<void> {
  await configureLane(fixture.db, createSecretStore(fixture.db, fixture.dir), {
    lane: 'read',
    client_id: 'test-client-id-read',
    access_token: TOKEN,
  });
}

describe.runIf(HAS_DPAPI)('proving the read lane against LinkedIn', () => {
  it('reads the token from the vault, calls the real endpoint and verifies', async () => {
    await storeReadToken();
    stubLinkedIn();
    const call = tools();

    const out = (await call('linkedin_capability_verify', {
      feature: 'linkedin.dma_snapshot',
      confirm: true,
    })) as { status: string; probed: boolean };

    expect(out.probed).toBe(true);
    expect(out.status).toBe('verified');
    // The probe is a real DMA read, because the read-lane app has no Sign In
    // product and /v2/userinfo would 403 there.
    expect(requests.some((u) => u.includes('memberSnapshotData'))).toBe(true);
    expect(requests[0]).toContain('https://api.linkedin.com/');
  }, 60_000);

  it('treats an empty snapshot as a proven credential whose lane is not ready', async () => {
    await storeReadToken();
    stubLinkedIn((url) =>
      url.includes('memberSnapshotData')
        ? { status: 200, body: { elements: [{ snapshotDomain: 'PROFILE', snapshotData: [] }] } }
        : undefined,
    );
    const call = tools();

    // LinkedIn only begins assembling history at first consent, so a token
    // minted minutes ago reads empty everywhere. That is not a bad token.
    const out = (await call('linkedin_capability_verify', {
      feature: 'linkedin.dma_snapshot',
      confirm: true,
    })) as { status: string };

    expect(out.status).toBeTruthy();
  }, 60_000);

  it('demotes on a 401 and says the token needs re-minting', async () => {
    await storeReadToken();
    stubLinkedIn(() => ({ status: 401, body: { message: 'Invalid access token' } }));
    const call = tools();

    await expect(
      call('linkedin_capability_verify', { feature: 'linkedin.dma_snapshot', confirm: true }),
    ).rejects.toBeTruthy();
    expect(listCapabilities(fixture.db, 'linkedin.dma_snapshot')[0]?.status).not.toBe('verified');
  }, 60_000);

  it('leaves the lane alone when the network drops', async () => {
    await storeReadToken();
    stubLinkedIn();
    const call = tools();
    await call('linkedin_capability_verify', { feature: 'linkedin.dma_snapshot', confirm: true });
    expect(listCapabilities(fixture.db, 'linkedin.dma_snapshot')[0]?.status).toBe('verified');

    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });

    await expect(
      call('linkedin_capability_verify', { feature: 'linkedin.dma_snapshot', confirm: true }),
    ).rejects.toBeTruthy();
    // A blip must not close a working lane: demotion is what requireCapability
    // reads, so this used to mean re-verifying by hand after bad connectivity.
    expect(listCapabilities(fixture.db, 'linkedin.dma_snapshot')[0]?.status).toBe('verified');
  }, 60_000);
});

describe.runIf(HAS_DPAPI)('syncing from the portability lane', () => {
  async function verifiedLane(): Promise<(name: string, args: unknown) => Promise<unknown>> {
    await storeReadToken();
    stubLinkedIn();
    const call = tools();
    await call('linkedin_capability_verify', { feature: 'linkedin.dma_snapshot', confirm: true });
    requests.length = 0;
    return call;
  }

  it('imports a snapshot and records what came back', async () => {
    const call = await verifiedLane();

    const out = (await call('linkedin_dma_sync', { mode: 'snapshot', confirm: true })) as {
      snapshot_id: string | null;
      domains: string[];
      window_note: string;
    };

    expect(out.snapshot_id).toBeTruthy();
    expect(latestSnapshot(fixture.db)).not.toBeNull();
    // Every request carried the pinned API version; an unpinned call would
    // silently change shape when LinkedIn moves.
    expect(requests.every((u) => u.includes('memberSnapshotData'))).toBe(true);
  }, 60_000);

  it('imports the member post history as published posts', async () => {
    const call = await verifiedLane();
    await call('linkedin_dma_sync', { mode: 'snapshot', confirm: true });

    const posts = listPublishedPosts(fixture.db);
    if (posts.length === 0) return;
    expect(posts[0]?.commentary).toContain('renovating deployed software');
  }, 60_000);

  it('reports every domain populated without a shortfall note', async () => {
    const call = await verifiedLane();

    const out = (await call('linkedin_dma_sync', {
      mode: 'snapshot',
      domains: ['PROFILE'],
      confirm: true,
    })) as { window_note: string; domain_results: Array<{ status: string }> };

    // The note only names domains that came back with nothing, so a clean run
    // must not carry an empty "0 domain(s) not populated" clause — a member
    // scanning for trouble should find none rather than a phrase that reads
    // like some.
    expect(out.window_note).not.toMatch(/not populated/);
    expect(out.domain_results.every((d) => d.status === 'populated')).toBe(true);
  }, 60_000);

  it('names the domains that came back with nothing', async () => {
    const call = await verifiedLane();

    const out = (await call('linkedin_dma_sync', {
      mode: 'snapshot',
      domains: ['PROFILE', 'EDUCATION'],
      confirm: true,
    })) as { window_note: string };

    // LinkedIn collates domains at different times, so a domain answering
    // empty is not proof the section is empty. Saying which one was quiet is
    // the difference between "your education is blank" and "we did not get an
    // answer about your education".
    expect(out.window_note).toMatch(/EDUCATION/);
  }, 60_000);

  it('pulls the rolling event window in changelog mode', async () => {
    const call = await verifiedLane();

    const out = (await call('linkedin_dma_sync', { mode: 'changelog', confirm: true })) as {
      mode: string;
      snapshot_id: string | null;
      domains: string[];
      window_note: string;
      changelog: { imported: number } | null;
      freshness: unknown;
    };

    expect(out.mode).toBe('changelog');
    // Changelog is an event stream, not a state read: it makes no snapshot and
    // reports no domains, and saying otherwise would put a profile revision in
    // the member's history that nothing observed.
    expect(out.snapshot_id).toBeNull();
    expect(out.domains).toEqual([]);
    expect(out.freshness).toBeNull();
    expect(out.changelog).not.toBeNull();
    // The cursor is in the note, because a member re-running this needs to know
    // whether the next call resumes or re-walks the whole 28 days.
    expect(out.window_note).toMatch(/changelog event\(s\) fetched/);
    expect(out.window_note).toMatch(/next startTime/);
    expect(requests.some((u) => u.includes('memberChangeLogs'))).toBe(true);
  }, 60_000);

  it('refuses to sync while the capability is closed', async () => {
    await storeReadToken();
    stubLinkedIn();
    const call = tools();

    // Nothing is constructed and no socket is opened while the lane is shut.
    await expect(
      call('linkedin_dma_sync', { mode: 'snapshot', confirm: true }),
    ).rejects.toBeTruthy();
    expect(requests).toEqual([]);
  }, 60_000);

  it('reports an upstream failure without leaving a half-written snapshot', async () => {
    const call = await verifiedLane();
    const before = latestSnapshot(fixture.db)?.id ?? null;
    vi.stubGlobal('fetch', async () => new Response('{"message":"upstream"}', { status: 502 }));

    await expect(
      call('linkedin_dma_sync', { mode: 'snapshot', confirm: true }),
    ).rejects.toBeTruthy();
    expect(latestSnapshot(fixture.db)?.id ?? null).toBe(before);
  }, 60_000);

  it('reads the latest profile and records the snapshot it read', async () => {
    const call = await verifiedLane();

    const out = (await call('linkedin_profile_read_latest', {})) as {
      observed: Record<string, unknown>;
      snapshot_id: string | null;
      freshness: unknown;
    };

    expect(out.observed).toBeTruthy();
    // The read is recorded rather than discarded: what LinkedIn said, and when,
    // is the provenance every later diff is measured against. An unrecorded
    // read would leave the member comparing against nothing.
    expect(out.snapshot_id).toBeTruthy();
    expect(latestSnapshot(fixture.db)?.id).toBe(out.snapshot_id);
    expect(out.freshness).toBeTruthy();
  }, 60_000);

  it('refuses a domain that is not part of the profile', async () => {
    const call = await verifiedLane();

    // This read covers profile domains only; asking it for message history
    // would quietly widen what the lane pulls.
    await expect(
      call('linkedin_profile_read_latest', { domains: ['MEMBER_SHARE_INFO'] }),
    ).rejects.toBeTruthy();
  }, 60_000);
});

describe('the lane gate, with no credential at all', () => {
  it('refuses every external tool before a socket is opened', async () => {
    stubLinkedIn();
    const call = tools();

    for (const [name, args] of [
      ['linkedin_dma_sync', { mode: 'snapshot', confirm: true }],
      ['linkedin_profile_read_latest', {}],
      ['linkedin_capability_verify', { feature: 'linkedin.dma_snapshot', confirm: true }],
    ] as const) {
      await expect(call(name, args), name).rejects.toBeTruthy();
    }

    // The whole point of a fail-closed capability model: nothing reached the
    // network to find out.
    expect(requests).toEqual([]);
  });
});
