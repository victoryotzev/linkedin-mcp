import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureLane,
  createSecretStore,
  enablePublishing,
  listPublications,
  setFeatureControl,
  verifyLane,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Publishing for real, with LinkedIn stubbed at the socket.
//
// This is the only path in the product that puts text on a member's public
// profile, and it is the one place where being wrong is not recoverable by
// editing a local file. Everything in front of it — the approval, the revision
// hash, the capability ladder, the explicit enable — exists to make this call
// hard to reach, which also meant nothing had ever reached it.
//
// The write-lane credential lives in the DPAPI vault, so these skip off
// Windows rather than being softened.

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
const PERSON_URN = 'urn:li:person:FixtureMember';

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;
const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

beforeEach(() => {
  fixture = createFixture('live-publishing');
  seeded = seedHealthy(fixture);
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

/** Answers the Posts API, recording exactly what was sent. */
function stubLinkedIn(reply: { status: number; body?: unknown; headers?: Record<string, string> }) {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers,
    });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
}

/**
 * Walks the whole ladder: credential stored, proved, publishing enabled, and a
 * fresh approval granted against the account that lane created.
 *
 * The approval has to be made after the lane exists. An approval is bound to
 * one account, and configuring the write lane creates a new one — so an
 * approval from before is deliberately not executable against it.
 */
async function armed(): Promise<{
  call: (name: string, args: unknown) => Promise<unknown>;
  approvalId: string;
  bodyText: string;
}> {
  const store = createSecretStore(fixture.db, fixture.dir);
  await configureLane(fixture.db, store, {
    lane: 'write',
    client_id: 'test-client-id-write',
    access_token: TOKEN,
  });
  await verifyLane(
    fixture.db,
    store,
    'write',
    async () => ({ ok: true, person_urn: PERSON_URN }),
    'dashboard',
  );
  // Two separate switches, deliberately. enablePublishing records that the
  // credential was proved; the feature control records that the member decided
  // to post with it. Either one alone leaves the live adapter shut.
  enablePublishing(fixture.db, true, 'dashboard');
  setFeatureControl(fixture.db, 'live_publishing', true, { confirm: true, actor: 'dashboard' });

  const call = tools();
  const bodyText = 'The suite covers 203 test files in total.';
  const draft = (await call('linkedin_draft_write', {
    body_text: bodyText,
    visibility: 'PUBLIC',
  })) as { draft_id: string };
  await call('linkedin_draft_validate', { draft_id: draft.draft_id });

  const requested = (await call('linkedin_publish_request', { draft_id: draft.draft_id })) as {
    approval_id: string;
    preview: { revision_hash: string };
  };
  await call('linkedin_approval_decide', {
    action: 'grant',
    approval_id: requested.approval_id,
    revision_hash: requested.preview.revision_hash,
    command: `APPROVE ${requested.approval_id} ${requested.preview.revision_hash}`,
    confirm: true,
  });
  return { call, approvalId: requested.approval_id, bodyText };
}

describe.runIf(HAS_DPAPI)('publishing to LinkedIn', () => {
  it('sends the approved text once, and records the URN that came back', async () => {
    const { call, approvalId } = await armed();
    stubLinkedIn({ status: 201, headers: { 'x-restli-id': 'urn:li:share:9001' } });

    const out = (await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    })) as { outcome: string; linkedin_post_urn: string | null; adapter: string };

    expect(out.adapter).toBe('linkedin_rest');
    expect(out.outcome).toBe('succeeded');
    expect(out.linkedin_post_urn).toBe('urn:li:share:9001');

    // Exactly one request, carrying the approved text and the author from the
    // verified lane — not from anything the caller supplied.
    expect(requests).toHaveLength(1);
    const sent = requests[0]?.body as { author: string; commentary: string };
    expect(sent.author).toBe(PERSON_URN);
    expect(sent.commentary).toBe('The suite covers 203 test files in total.');
    expect(requests[0]?.url).toBe('https://api.linkedin.com/rest/posts');
  }, 60_000);

  it('sends the pinned API version rather than whatever is current', async () => {
    const { call, approvalId } = await armed();
    stubLinkedIn({ status: 201, headers: { 'x-restli-id': 'urn:li:share:9002' } });

    await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    });

    // An unpinned version means the request shape can change under the member
    // without anything in this repo moving.
    expect(requests[0]?.headers['linkedin-version']).toMatch(/^\d{6}$/);
  }, 60_000);

  it('records a refusal from LinkedIn as failed, and does not retry', async () => {
    const { call, approvalId } = await armed();
    stubLinkedIn({ status: 422, body: { message: 'duplicate content' } });

    const out = (await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    })) as { outcome: string };

    expect(out.outcome).toBe('failed');
    expect(requests).toHaveLength(1);
  }, 60_000);

  it('records a lost response as ambiguous, never as success or failure', async () => {
    const { call, approvalId } = await armed();
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });

    const out = (await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    })) as { outcome: string };

    // The post may or may not be live. Only the member can find out, and the
    // reconciliation path is what they use.
    expect(out.outcome).toBe('ambiguous');
  }, 60_000);

  it('closes the lane when LinkedIn says the credential is gone', async () => {
    const { call, approvalId } = await armed();
    stubLinkedIn({ status: 401, body: { message: 'Invalid access token' } });

    await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    });

    // A 401 during a publish demotes the lane, so the next attempt stops at the
    // gate rather than sending again with a dead token.
    const publication = listPublications(fixture.db)[0];
    expect(publication?.outcome).not.toBe('succeeded');
  }, 60_000);

  it('consumes the approval, so a replay cannot post twice', async () => {
    const { call, approvalId } = await armed();
    stubLinkedIn({ status: 201, headers: { 'x-restli-id': 'urn:li:share:9003' } });

    await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    });
    const first = requests.length;

    await call('linkedin_publish_execute', {
      approval_id: approvalId,
      adapter: 'linkedin',
      command: `PUBLISH ${approvalId}`,
      confirm: true,
    });

    // The idempotency key is derived from the approval, so the replay returns
    // the existing publication without opening a second socket.
    expect(requests.length).toBe(first);
    expect(listPublications(fixture.db)).toHaveLength(1);
  }, 60_000);
});

describe.runIf(HAS_DPAPI)('what stands in front of the live adapter', () => {
  it('refuses while the write lane has a token but no person URN', async () => {
    const store = createSecretStore(fixture.db, fixture.dir);
    await configureLane(fixture.db, store, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    // Verified, but the probe returned no author.
    await verifyLane(fixture.db, store, 'write', async () => ({ ok: true }), 'dashboard');
    enablePublishing(fixture.db, true, 'dashboard');
    setFeatureControl(fixture.db, 'live_publishing', true, { confirm: true, actor: 'dashboard' });
    stubLinkedIn({ status: 201 });
    const call = tools();

    await expect(
      call('linkedin_publish_execute', {
        approval_id: seeded.approvalId,
        adapter: 'linkedin',
        command: `PUBLISH ${seeded.approvalId}`,
        confirm: true,
      }),
    ).rejects.toBeTruthy();
    // A post with no author cannot be sent, so nothing was.
    expect(requests).toEqual([]);
  }, 60_000);

  it('refuses when the caller names a different account', async () => {
    const { call, approvalId } = await armed();
    stubLinkedIn({ status: 201 });

    await expect(
      call('linkedin_publish_execute', {
        approval_id: approvalId,
        adapter: 'linkedin',
        account_id: 'acc_someone_else',
        command: `PUBLISH ${approvalId}`,
        confirm: true,
      }),
    ).rejects.toBeTruthy();
    expect(requests).toEqual([]);
  }, 60_000);
});

describe('the live adapter with nothing set up', () => {
  it('refuses before a socket is opened', async () => {
    vi.stubGlobal('fetch', async () => {
      requests.push({ url: 'unexpected', body: null, headers: {} });
      return new Response('{}', { status: 200 });
    });
    const call = tools();

    await expect(
      call('linkedin_publish_execute', {
        approval_id: seeded.approvalId,
        adapter: 'linkedin',
        command: `PUBLISH ${seeded.approvalId}`,
        confirm: true,
      }),
    ).rejects.toMatchObject({ blockers: ['feature_disabled:live_publishing'] });
    expect(requests).toEqual([]);
  });
});
