import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeLane } from '@linkedin-mcp/domain';

// What this decides is whether a credential gets demoted, and demotion is what
// requireCapability reads. Getting the transient cases wrong turns a moment of
// bad connectivity into a lane the member has to re-verify by hand, so the
// retryable branch matters at least as much as the failure branch.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Replies to every request with one canned response. */
function stubFetch(reply: () => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply()),
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('write lane', () => {
  it('is proven by an OIDC identity, and returns the person URN publishing needs', async () => {
    stubFetch(() => json({ sub: 'abc123', name: 'Alex Rivera' }));

    const result = await probeLane('write', 'a-token-long-enough-to-pass-validation');

    expect(result).toEqual({ ok: true, person_urn: 'urn:li:person:abc123' });
  });
});

describe('read lane', () => {
  it('is proven by a real snapshot read', async () => {
    // The walk stops at the first empty page, so a stub that answers the same
    // rows forever would run to the page cap rather than finishing.
    let call = 0;
    stubFetch(() =>
      json({ elements: [{ snapshotData: call++ === 0 ? [{ 'First Name': 'Alex' }] : [] }] }),
    );

    const result = await probeLane('read', 'a-token-long-enough-to-pass-validation');

    expect(result.ok).toBe(true);
    expect((result as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it('treats an empty snapshot as a working credential, not a bad one', async () => {
    // LinkedIn only begins assembling historical data at first consent, so a
    // token minted minutes ago reads empty across every domain. Demoting on
    // that would close a lane that is in fact fine.
    stubFetch(() => json({ elements: [{ snapshotData: [] }] }));

    const result = await probeLane('read', 'a-token-long-enough-to-pass-validation');

    expect(result.ok).toBe(true);
    expect((result as { warnings?: string[] }).warnings).toEqual(['snapshot_not_ready']);
  });
});

describe('definite credential failures', () => {
  it('maps 401 to a non-retryable 401', async () => {
    stubFetch(() => json({ message: 'expired' }, 401));

    const result = await probeLane('read', 'a-token-long-enough-to-pass-validation');

    expect(result).toMatchObject({ ok: false, status: 401, retryable: false });
    expect((result as { message: string }).message).toMatch(/expired or was revoked/);
  });

  it('maps 403 to a non-retryable 403', async () => {
    stubFetch(() => json({ message: 'no product' }, 403));

    const result = await probeLane('write', 'a-token-long-enough-to-pass-validation');

    expect(result).toMatchObject({ ok: false, status: 403, retryable: false });
    expect((result as { message: string }).message).toMatch(/product or scope/);
  });
});

describe('failures that say nothing about the credential', () => {
  it('reports a transport error as retryable rather than demoting the lane', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed: ECONNRESET');
      }),
    );

    const result = await probeLane('read', 'a-token-long-enough-to-pass-validation');

    expect(result).toMatchObject({ ok: false, status: 0, retryable: true });
    expect((result as { message: string }).message).toMatch(/ECONNRESET|fetch failed/);
  });

  it('does not demote on a rate limit or an upstream 5xx', async () => {
    for (const status of [429, 500, 503]) {
      stubFetch(() => json({ message: 'later' }, status));

      const result = await probeLane('read', 'a-token-long-enough-to-pass-validation');

      expect(result.ok).toBe(false);
      // status 0 is what keeps demoteLane from firing; a real 401/403 is the
      // only thing that should close a lane.
      expect((result as { status: number }).status).toBe(0);
      expect((result as { retryable?: boolean }).retryable).toBe(true);
    }
  });
});

describe('input guards', () => {
  it('refuses an empty token before opening a socket', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeLane('write', '   ');

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
