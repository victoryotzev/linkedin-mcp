import { describe, expect, it } from 'vitest';
import { DomainError } from '@linkedin-mcp/shared';
import { DmaClient, assertLinkedInUrl } from '../../packages/linkedin/src/dmaClient.ts';
import { OidcClient } from '../../packages/linkedin/src/oidcClient.ts';
import { LinkedInRestPublisher } from '../../packages/linkedin/src/adapters.ts';

const TOKEN = 'AQV-super-secret-access-token-0123456789';

interface Call {
  url: string;
  headers: Record<string, string>;
  method: string;
  body: string | null;
}

// Records every request and answers from a scripted queue, so each test can
// assert on what would have gone over the wire without one existing.
function fakeFetch(script: Array<(call: Call) => Response>): {
  impl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      url,
      headers,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const next = script[calls.length - 1];
    if (!next) throw new Error(`unscripted request #${calls.length} to ${url}`);
    return next(call);
  };
  return { impl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function snapshotBody(domain: string, rows: Array<Record<string, unknown>>): unknown {
  return { elements: [{ snapshotDomain: domain, snapshotData: rows }], paging: {} };
}

const NO_MORE_DATA = json({ message: 'No data found for this memberId', status: 400 }, 400);

describe('DmaClient snapshot pagination', () => {
  it('walks pages and stops cleanly on the end-of-data error', async () => {
    const { impl, calls } = fakeFetch([
      () => json(snapshotBody('PROFILE', [{ id: 1 }, { id: 2 }])),
      () => json(snapshotBody('PROFILE', [{ id: 3 }])),
      () => NO_MORE_DATA.clone(),
    ]);
    const page = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchSnapshotDomain(
      'PROFILE',
    );

    expect(page.domain).toBe('PROFILE');
    expect(page.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(calls).toHaveLength(3);
    // `start` is a page index, not a row offset. LinkedIn's documented sample
    // answers a count=10 request with a next link of start=1 — so multiplying
    // by the page size would step 0, 10, 20 and skip nine pages in every ten.
    expect(calls.map((c) => new URL(c.url).searchParams.get('start'))).toEqual(['0', '1', '2']);
    expect(new URL(calls[0]!.url).searchParams.get('count')).toBe('10');
  });

  // The live API and the documentation disagree on this sentinel, and getting it
  // wrong is silent: the walk dies on its own terminator and reports the failure
  // as if the credential were bad.
  it.each([
    ['the live 404 wording', 404, 'No data found for this domain and memberId.'],
    ['the documented 400 wording', 400, 'No data found for this memberId'],
  ])('ends the walk on %s', async (_name, status, message) => {
    const { impl } = fakeFetch([
      () => json(snapshotBody('PROFILE', [{ id: 1 }])),
      () => json({ message, status }, status),
    ]);
    const page = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchSnapshotDomain(
      'PROFILE',
    );
    expect(page.rows).toEqual([{ id: 1 }]);
  });

  it('reports a domain LinkedIn has not assembled yet as empty, not as a failure', async () => {
    const { impl } = fakeFetch([
      () => json({ message: 'No data found for this domain and memberId.', status: 404 }, 404),
    ]);
    const page = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchSnapshotDomain(
      'PROFILE',
    );
    expect(page.rows).toEqual([]);
  });

  // The page caps bound the damage if LinkedIn ever changes the sentinel that
  // terminates a walk. Untested until now, and the domain layer now depends on
  // the specific blocker to tell "incomplete" apart from "failed".
  it('discards a walk that never terminates rather than importing it as complete', async () => {
    const { impl, calls } = fakeFetch(
      Array.from({ length: 201 }, () => () => json(snapshotBody('PROFILE', [{ id: 1 }]))),
    );
    const err = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl })
      .fetchSnapshotDomain('PROFILE')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).blockers).toEqual(['snapshot_page_cap']);
    expect((err as DomainError).message).toContain('discarded rather than imported as complete');
    expect(calls).toHaveLength(200);
  });

  it('discards a changelog walk that never terminates and leaves the watermark alone', async () => {
    const { impl, calls } = fakeFetch(
      Array.from(
        { length: 201 },
        () => () => json({ elements: Array.from({ length: 50 }, (_, i) => ({ id: i })) }),
      ),
    );
    const err = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl })
      .fetchChangelog(0)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).blockers).toEqual(['changelog_page_cap']);
    expect(calls).toHaveLength(200);
  });

  it('still fails loudly when a 5xx carries the sentinel wording', async () => {
    const { impl } = fakeFetch([
      () => json({ message: 'No data found for this memberId', status: 500 }, 500),
    ]);
    // Terminating quietly here would report an outage as a complete import.
    await expect(
      new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchSnapshotDomain('PROFILE'),
    ).rejects.toThrowError(DomainError);
  });

  it('drops elements belonging to a different snapshot domain', async () => {
    const { impl } = fakeFetch([
      () =>
        json({
          elements: [
            { snapshotDomain: 'PROFILE', snapshotData: [{ id: 'keep' }] },
            { snapshotDomain: 'INBOX', snapshotData: [{ id: 'drop' }] },
          ],
        }),
      () => NO_MORE_DATA.clone(),
    ]);
    const page = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchSnapshotDomain(
      'PROFILE',
    );
    expect(page.rows).toEqual([{ id: 'keep' }]);
  });

  it('refuses a blocked domain before any request is made', async () => {
    const { impl, calls } = fakeFetch([]);
    const client = new DmaClient({ accessToken: TOKEN, fetchImpl: impl });

    await expect(client.fetchSnapshotDomain('INBOX')).rejects.toThrowError(DomainError);
    await expect(client.fetchSnapshotDomain('NOT_A_DOMAIN')).rejects.toThrowError(DomainError);
    expect(calls).toHaveLength(0);
  });
});

describe('pinned headers', () => {
  it('sends LinkedIn-Version 202312 and the Rest.li version on DMA calls', async () => {
    const { impl, calls } = fakeFetch([() => NO_MORE_DATA.clone(), () => json({ elements: [] })]);
    const client = new DmaClient({ accessToken: TOKEN, fetchImpl: impl });
    await client.fetchSnapshotDomain('SKILLS');
    await client.fetchChangelog(1_700_000_000_000, 25);

    for (const call of calls) {
      expect(call.headers['linkedin-version']).toBe('202312');
      expect(call.headers['x-restli-protocol-version']).toBe('2.0.0');
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(call.url.startsWith('https://api.linkedin.com/rest/')).toBe(true);
    }
  });

  it('omits the version header on the unversioned /v2/userinfo endpoint', async () => {
    const { impl, calls } = fakeFetch([() => json({ sub: 'ABC123', name: 'A Member' })]);
    await new OidcClient({ accessToken: TOKEN, fetchImpl: impl }).fetchIdentity();

    const call = calls[0];
    expect(call?.url).toBe('https://api.linkedin.com/v2/userinfo');
    expect(call?.headers['linkedin-version']).toBeUndefined();
    expect(call?.headers['x-restli-protocol-version']).toBeUndefined();
  });
});

describe('LinkedIn Posts publisher', () => {
  const request = {
    idempotency_key: 'once',
    body_text: 'A verified post',
    visibility: 'PUBLIC',
    media: [],
    account_id: 'acc_write',
  };

  it('sends the documented text-post shape and returns x-restli-id', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } }),
    ]);
    const result = await new LinkedInRestPublisher({
      accessToken: TOKEN,
      authorUrn: 'urn:li:person:ABC123',
      postsApiVersion: '202605',
      dmaApiVersion: '202312',
      fetchImpl: impl,
    }).publish(request);

    expect(result).toMatchObject({ status: 'succeeded', post_urn: 'urn:li:share:123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.linkedin.com/rest/posts',
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'linkedin-version': '202605',
        'x-restli-protocol-version': '2.0.0',
      },
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      author: 'urn:li:person:ABC123',
      commentary: 'A verified post',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    expect(calls[0]!.body).not.toContain(TOKEN);
  });

  it('distinguishes rejected requests from uncertain outcomes without leaking the token', async () => {
    const rejected = fakeFetch([() => new Response(`${TOKEN}`, { status: 403 })]);
    const unavailable = fakeFetch([() => new Response(null, { status: 503 })]);
    const lost: typeof fetch = async () => {
      throw new Error(`socket ${TOKEN}`);
    };
    const config = {
      accessToken: TOKEN,
      authorUrn: 'urn:li:person:ABC123',
      postsApiVersion: '202605',
      dmaApiVersion: '202312' as const,
    };
    const outcomes = [
      await new LinkedInRestPublisher({ ...config, fetchImpl: rejected.impl }).publish(request),
      await new LinkedInRestPublisher({ ...config, fetchImpl: unavailable.impl }).publish(request),
      await new LinkedInRestPublisher({ ...config, fetchImpl: lost }).publish(request),
    ];
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'ambiguous', 'ambiguous']);
    expect(JSON.stringify(outcomes)).not.toContain(TOKEN);
  });

  it('reports a proven authorization failure so the write lane can be closed', async () => {
    const { impl } = fakeFetch([() => new Response(null, { status: 401 })]);
    const failures: number[] = [];
    const result = await new LinkedInRestPublisher({
      accessToken: TOKEN,
      authorUrn: 'urn:li:person:ABC123',
      postsApiVersion: '202605',
      dmaApiVersion: '202312',
      fetchImpl: impl,
      onAuthorizationFailure: (status) => failures.push(status),
    }).publish(request);
    expect(result.status).toBe('failed');
    expect(failures).toEqual([401]);
  });
});

describe('host pinning', () => {
  it('refuses a non-LinkedIn host outright', () => {
    for (const url of [
      'https://api.linkedin.com.evil.example/rest/memberSnapshotData',
      'http://api.linkedin.com/rest/memberSnapshotData',
      'https://evil.example/v2/userinfo',
    ]) {
      expect(() => assertLinkedInUrl(url)).toThrowError(DomainError);
    }
    expect(() => assertLinkedInUrl('https://api.linkedin.com/v2/userinfo')).not.toThrow();
  });

  it('refuses a response that came from somewhere else', async () => {
    const { impl } = fakeFetch([
      () =>
        new Response('{}', {
          status: 200,
          // A followed redirect would have handed the bearer token away.
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const redirected: typeof fetch = async (input, init) => {
      const response = await impl(input, init);
      Object.defineProperty(response, 'url', { value: 'https://evil.example/v2/userinfo' });
      return response;
    };
    await expect(
      new OidcClient({ accessToken: TOKEN, fetchImpl: redirected }).fetchIdentity(),
    ).rejects.toThrowError(/non-LinkedIn host/);
  });
});

describe('auth failures', () => {
  it('distinguishes 401 (token dead) from 403 (product or scope missing)', async () => {
    const expired = fakeFetch([() => json({ message: 'Invalid access token' }, 401)]);
    const forbidden = fakeFetch([() => json({ message: 'Not enough permissions' }, 403)]);

    const errors: DomainError[] = [];
    for (const { impl } of [expired, forbidden]) {
      await new DmaClient({ accessToken: TOKEN, fetchImpl: impl })
        .fetchSnapshotDomain('PROFILE')
        .then(
          () => expect.unreachable('should have thrown'),
          (err: unknown) => {
            expect(err).toBeInstanceOf(DomainError);
            errors.push(err as DomainError);
          },
        );
    }

    const [unauthorized, refused] = errors;
    expect(unauthorized?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(unauthorized?.blockers).toEqual(['token_expired_or_revoked']);
    expect(refused?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(refused?.blockers).toEqual(['product_or_scope_missing']);
    expect(unauthorized?.blockers).not.toEqual(refused?.blockers);
  });

  it('flags a rejected version pin as a stale-version blocker', async () => {
    const { impl } = fakeFetch([() => json({ message: 'unsupported version' }, 426)]);
    await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchChangelog(0).then(
      () => expect.unreachable('should have thrown'),
      (err: unknown) => {
        expect((err as DomainError).blockers).toEqual(['stale_api_version']);
      },
    );
  });
});

describe('rate limiting', () => {
  it('honours Retry-After on 429 and succeeds on the retry', async () => {
    const { impl, calls } = fakeFetch([
      () => json({ message: 'slow down' }, 429, { 'retry-after': '0' }),
      () => json(snapshotBody('PROFILE', [{ id: 'after-retry' }])),
      () => NO_MORE_DATA.clone(),
    ]);
    const page = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchSnapshotDomain(
      'PROFILE',
    );

    expect(page.rows).toEqual([{ id: 'after-retry' }]);
    expect(calls).toHaveLength(3);
  });

  it('gives up after three attempts and reports a retryable error', async () => {
    const { impl, calls } = fakeFetch(
      Array.from({ length: 3 }, () => () => json({}, 429, { 'retry-after': '0' })),
    );
    await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchChangelog(0, 1).then(
      () => expect.unreachable('should have thrown'),
      (err: unknown) => {
        expect((err as DomainError).retryable).toBe(true);
        expect((err as DomainError).blockers).toEqual(['rate_limited']);
      },
    );
    expect(calls).toHaveLength(3);
  });
});

describe('changelog arguments', () => {
  it('rejects a count outside [1, 50] and a negative startTime', async () => {
    const { impl, calls } = fakeFetch([]);
    const client = new DmaClient({ accessToken: TOKEN, fetchImpl: impl });

    await expect(client.fetchChangelog(0, 0)).rejects.toThrowError(DomainError);
    await expect(client.fetchChangelog(0, 51)).rejects.toThrowError(DomainError);
    await expect(client.fetchChangelog(-1)).rejects.toThrowError(DomainError);
    expect(calls).toHaveLength(0);
  });

  it('returns the elements array of a changelog page', async () => {
    const { impl, calls } = fakeFetch([
      () => json({ elements: [{ id: 1 }, 'not-an-object', { id: 2 }] }),
    ]);
    const rows = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchChangelog(
      1_700_000_000_000,
      50,
    );
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    const params = new URL(calls[0]?.url ?? '').searchParams;
    expect(params.get('q')).toBe('memberAndApplication');
    expect(params.get('start')).toBe('0');
    expect(params.get('count')).toBe('50');
    expect(params.get('startTime')).toBe('1700000000000');
  });

  it('walks offset pages until LinkedIn returns a short page', async () => {
    const first = Array.from({ length: 2 }, (_, id) => ({ id }));
    const { impl, calls } = fakeFetch([
      () => json({ elements: first }),
      () => json({ elements: [{ id: 2 }] }),
    ]);
    const rows = await new DmaClient({ accessToken: TOKEN, fetchImpl: impl }).fetchChangelog(
      1_700_000_000_000,
      2,
    );
    expect(rows).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('start')).toBe('0');
    expect(new URL(calls[1]?.url ?? '').searchParams.get('start')).toBe('2');
  });
});

describe('OIDC identity', () => {
  it('derives the person URN and tolerates a missing email', async () => {
    const { impl } = fakeFetch([
      () => json({ sub: 'ABC123', given_name: 'Ada', family_name: 'Lovelace', locale: 'en_US' }),
    ]);
    const identity = await new OidcClient({
      accessToken: TOKEN,
      fetchImpl: impl,
    }).fetchIdentity();

    expect(identity).toEqual({
      sub: 'ABC123',
      person_urn: 'urn:li:person:ABC123',
      name: 'Ada Lovelace',
      email: null,
    });
  });

  it('fails when the response carries no sub claim', async () => {
    const { impl } = fakeFetch([() => json({ name: 'A Member' })]);
    await expect(
      new OidcClient({ accessToken: TOKEN, fetchImpl: impl }).fetchIdentity(),
    ).rejects.toThrowError(DomainError);
  });
});

describe('secret hygiene', () => {
  it('never puts the access token in a thrown message, even when LinkedIn echoes it', async () => {
    const echo = (status: number): Response =>
      json({ message: `rejected request with Authorization: Bearer ${TOKEN}` }, status);

    const thrown: unknown[] = [];
    for (const status of [400, 401, 403, 500]) {
      const { impl } = fakeFetch([() => echo(status)]);
      await new DmaClient({ accessToken: TOKEN, fetchImpl: impl })
        .fetchSnapshotDomain('PROFILE')
        .catch((err: unknown) => thrown.push(err));
    }
    const { impl: oidcImpl } = fakeFetch([() => echo(401)]);
    await new OidcClient({ accessToken: TOKEN, fetchImpl: oidcImpl })
      .fetchIdentity()
      .catch((err: unknown) => thrown.push(err));
    const { impl: brokenImpl } = fakeFetch([
      () => new Response(`<html>${TOKEN}</html>`, { status: 200 }),
    ]);
    await new DmaClient({ accessToken: TOKEN, fetchImpl: brokenImpl })
      .fetchChangelog(0)
      .catch((err: unknown) => thrown.push(err));

    expect(thrown).toHaveLength(6);
    for (const err of thrown) {
      expect(err).toBeInstanceOf(DomainError);
      const message = (err as DomainError).message;
      expect(message).not.toContain(TOKEN);
      expect(message).toContain('[redacted]');
    }
  });

  it('refuses to construct a client without a token rather than calling anonymously', () => {
    expect(() => new DmaClient({ accessToken: '   ' })).toThrowError(DomainError);
    expect(() => new OidcClient({ accessToken: '' })).toThrowError(DomainError);
  });
});
