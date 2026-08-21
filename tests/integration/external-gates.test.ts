import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { requireCapability, seedCapabilities, syncFromDma } from '@linkedin-mcp/domain';
import {
  DMA_BLOCKED_DOMAINS,
  DmaClient,
  LinkedInRestPublisher,
  OidcClient,
} from '@linkedin-mcp/linkedin';
import { DomainError } from '@linkedin-mcp/shared';

let dir: string;
let db: SqliteDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-ext-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  seedCapabilities(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  vi.restoreAllMocks();
});

const TOKEN = 'fake-token-that-must-never-be-sent-anywhere';
const CONFIG = {
  accessToken: TOKEN,
  authorUrn: 'urn:li:person:ABC123',
  postsApiVersion: '202607',
  dmaApiVersion: '202312' as const,
};

// A fetch that fails the test if it is ever called. The point of these tests is
// that the gates stop execution *before* the network, so any call is a defect.
function forbiddenFetch(): typeof fetch {
  return (() => {
    throw new Error('network call attempted while the capability was not verified');
  }) as unknown as typeof fetch;
}

describe('external lanes fail closed', () => {
  it('every LinkedIn capability starts unavailable with an actionable blocker', () => {
    for (const feature of [
      'linkedin.oidc_userinfo',
      'linkedin.dma_snapshot',
      'linkedin.dma_changelog',
      'linkedin.publish_post',
      'linkedin.image_upload',
    ]) {
      try {
        requireCapability(db, feature);
        expect.unreachable(`${feature} should be gated`);
      } catch (err) {
        expect((err as DomainError).code).toBe('CAPABILITY_UNAVAILABLE');
        expect((err as DomainError).blockers).toContain('no_linkedin_app');
      }
    }
  });

  it('the sync path checks the capability before it touches the network', async () => {
    const client = new DmaClient({ accessToken: TOKEN, fetchImpl: forbiddenFetch() });
    await expect(syncFromDma(db, client)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });

  it('refuses a sensitive domain before any request is made', async () => {
    const client = new DmaClient({ accessToken: TOKEN, fetchImpl: forbiddenFetch() });
    for (const domain of DMA_BLOCKED_DOMAINS) {
      expect(() => client.assertDomainAllowed(domain), domain).toThrowError(DomainError);
      await expect(client.fetchSnapshotDomain(domain)).rejects.toBeInstanceOf(DomainError);
    }
    expect(() => client.assertDomainAllowed('PROFILE')).not.toThrow();
    expect(() => client.assertDomainAllowed('NOT_A_DOMAIN')).toThrowError(DomainError);
  });

  it('reports a local media blocker before any publishing request', async () => {
    const fetchImpl = forbiddenFetch();
    const result = await new LinkedInRestPublisher({ ...CONFIG, fetchImpl }).publish({
      idempotency_key: 'k',
      body_text: 'text',
      visibility: 'PUBLIC',
      media: [{ artifact_id: 'art_1', alt: 'alt' }],
      account_id: 'acc',
    });
    expect(result).toMatchObject({
      status: 'failed',
      meta: { blocker: 'media_upload_not_implemented' },
    });
  });

  it('never puts the access token in an error message', async () => {
    const failing = (async () =>
      new Response('nope', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    const oidc = new OidcClient({ accessToken: TOKEN, fetchImpl: failing });
    const dma = new DmaClient({ accessToken: TOKEN, fetchImpl: failing });

    for (const call of [() => oidc.fetchIdentity(), () => dma.fetchSnapshotDomain('PROFILE')]) {
      try {
        await call();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(String((err as Error).message)).not.toContain(TOKEN);
        expect(JSON.stringify(err)).not.toContain(TOKEN);
      }
    }
  });

  it('passes the gate only once a capability is verified', () => {
    db.run(
      "UPDATE capabilities SET status = 'verified', blockers_json = '[]' WHERE feature = 'linkedin.dma_snapshot'",
    );
    expect(requireCapability(db, 'linkedin.dma_snapshot').status).toBe('verified');
    expect(() => requireCapability(db, 'linkedin.publish_post')).toThrowError(DomainError);
  });
});
