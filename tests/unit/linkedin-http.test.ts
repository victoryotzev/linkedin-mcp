import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLinkedInUrl,
  httpFailureToDomainError,
  linkedInGet,
  LINKEDIN_API_HOST,
} from '@linkedin-mcp/linkedin';

// The one place this product talks to something it does not control.
//
// Nothing here opens a socket: fetch is replaced, and what is under test is how
// LinkedIn's answers are read. Two things matter. Every status maps to a
// distinct remedy — re-mint the token, add a product, bump the pinned version —
// because collapsing them sends a member to the wrong fix and each of those
// fixes takes ten minutes in a portal. And a rate limit is waited out the way
// LinkedIn asked, not the way we would guess, because DMA limits are
// undocumented and guessing wrong turns one 429 into three.

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';
const URL = `${LINKEDIN_API_HOST}/rest/memberSnapshotData?q=criteria&domain=PROFILE`;

afterEach(() => vi.unstubAllGlobals());

function answering(replies: Array<{ status: number; headers?: Record<string, string> }>): {
  calls: number;
} {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', async () => {
    const reply = replies[Math.min(state.calls, replies.length - 1)]!;
    state.calls += 1;
    return new Response('{}', {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
  return state;
}

describe('a rate limit', () => {
  it('waits the number of seconds LinkedIn asked for, then retries', async () => {
    const state = answering([{ status: 429, headers: { 'retry-after': '0' } }, { status: 200 }]);

    const result = await linkedInGet(URL, {}, fetch, TOKEN);

    expect(result.ok).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('understands a Retry-After given as a date', async () => {
    // Both forms are legal HTTP and LinkedIn does not document which it sends.
    // Reading a date as NaN seconds would fall back to a random backoff and
    // ignore the one instruction the server gave.
    const past = new Date(Date.now() - 60_000).toUTCString();
    const state = answering([{ status: 429, headers: { 'retry-after': past } }, { status: 200 }]);

    const result = await linkedInGet(URL, {}, fetch, TOKEN);

    expect(result.ok).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('ignores a Retry-After it cannot read and backs off on its own', async () => {
    const state = answering([
      { status: 429, headers: { 'retry-after': 'sometime next week' } },
      { status: 200 },
    ]);

    const result = await linkedInGet(URL, {}, fetch, TOKEN);

    expect(result.ok).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('gives up rather than retrying forever, and says to try again by hand', async () => {
    const state = answering([{ status: 429, headers: { 'retry-after': '0' } }]);

    const result = await linkedInGet(URL, {}, fetch, TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(state.calls).toBeGreaterThan(1);
    // Undocumented limits mean an automatic retry loop is a guess; the member
    // is told to come back later instead.
    expect(httpFailureToDomainError(result, 'reading the PROFILE snapshot').message).toMatch(
      /retry by hand later/i,
    );
  }, 30_000);
});

describe('what a failing status means', () => {
  const failure = (status: number) => ({ ok: false as const, status, body: '{"message":"no"}' });

  it('says the token died on a 401', () => {
    const error = httpFailureToDomainError(failure(401), 'verifying the read lane');

    expect(error.blockers).toContain('token_expired_or_revoked');
    expect(error.message).toMatch(/mint a fresh one/i);
  });

  it('says a product or scope is missing on a 403', () => {
    // Not the same remedy as a 401: the token is fine and the app is not.
    const error = httpFailureToDomainError(failure(403), 'verifying the read lane');

    expect(error.blockers).toContain('product_or_scope_missing');
    expect(error.message).toMatch(/developer portal/i);
  });

  it('says there is nothing to return on a 404, rather than that something broke', () => {
    const error = httpFailureToDomainError(failure(404), 'reading the PROFILE snapshot');

    // LinkedIn answers 404 for a domain it has not finished assembling. Calling
    // that a failure would send a member looking for a fault that is not there.
    expect(error.code).toBe('NOT_FOUND');
    expect(error.blockers).toContain('upstream_not_found');
  });

  it('says the pinned version needs bumping on a 426', () => {
    const error = httpFailureToDomainError(failure(426), 'reading the PROFILE snapshot');

    expect(error.blockers).toContain('stale_api_version');
    expect(error.message).toMatch(/changelog/i);
  });

  it('refuses the request outright on a 400', () => {
    expect(httpFailureToDomainError(failure(400), 'reading').blockers).toContain('bad_request');
  });

  it('reports an unmapped status with the number in it', () => {
    const error = httpFailureToDomainError(failure(503), 'reading the PROFILE snapshot');

    expect(error.message).toContain('503');
  });
});

describe('the URL it is willing to call', () => {
  it('accepts the pinned LinkedIn host', () => {
    expect(() => assertLinkedInUrl(`${LINKEDIN_API_HOST}/rest/me`)).not.toThrow();
  });

  it('refuses anywhere else, including a look-alike host', () => {
    // The token goes in an Authorization header. A redirect or a typo that sent
    // it somewhere else would hand a member's credential to a stranger.
    for (const url of [
      'https://api.linkedin.com.evil.example/rest/me',
      'http://api.linkedin.com/rest/me',
      'https://linkedin.com/rest/me',
      'https://api.linkedin.com@evil.example/rest/me',
    ]) {
      expect(() => assertLinkedInUrl(url), url).toThrow();
    }
  });

  it('refuses a response that arrived from somewhere else', async () => {
    vi.stubGlobal('fetch', async () =>
      Object.defineProperty(new Response('{}', { status: 200 }), 'url', {
        value: 'https://evil.example/rest/me',
      }),
    );

    // redirect: 'error' already refuses a redirect, and this is the belt to
    // that brace: the response's own URL is checked before its body is read.
    await expect(linkedInGet(URL, {}, fetch, TOKEN)).rejects.toThrow();
  });
});

describe('a request that never got an answer', () => {
  it('is reported as retryable, with the token kept out of the message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error(`socket hang up while sending ${TOKEN}`);
    });

    const failure = await linkedInGet(URL, {}, fetch, TOKEN).catch((e: unknown) => e);

    // Error messages travel into logs and MCP payloads; a credential echoed
    // back out of one is a credential leak with extra steps.
    expect(String(failure)).not.toContain(TOKEN);
    expect(String(failure)).toMatch(/failed before a response arrived/i);
  });
});
