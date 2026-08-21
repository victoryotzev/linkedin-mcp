import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkedInRestPublisher } from '@linkedin-mcp/linkedin';

// The live publisher, one refusal at a time.
//
// This is the last object between an approved draft and a member's public
// profile. Everything it declines to send it declines before opening a socket,
// and everything it cannot interpret it calls ambiguous rather than guessing —
// because "failed" and "published" are both claims, and only one of them can be
// wrong in a way the member cannot see.

const REQUEST = {
  idempotency_key: 'idem-1',
  body_text: 'The suite covers 203 test files in total.',
  visibility: 'PUBLIC',
  media: [] as Array<{ artifact_id: string; alt: string }>,
  account_id: 'acc_fixture',
};

const CONFIG = {
  accessToken: 'AQV-fake-fixture-token-not-a-real-credential-0123456789',
  authorUrn: 'urn:li:person:FixtureMember',
  postsApiVersion: '202605',
  // The DMA version is a literal in the config type: that lane is pinned to one
  // version rather than being a member-facing setting like the Posts one.
  dmaApiVersion: '202312' as const,
};

const sent: Array<{ url: string; init: RequestInit | undefined }> = [];

function stubFetch(reply: { status: number; headers?: Record<string, string>; body?: unknown }) {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe('what it refuses before opening a socket', () => {
  it('refuses a post carrying media, because uploading it is not built', async () => {
    stubFetch({ status: 201 });
    const outcome = await new LinkedInRestPublisher(CONFIG).publish({
      ...REQUEST,
      media: [{ artifact_id: 'art_1', alt: 'a screenshot' }],
    });

    expect(outcome.status).toBe('failed');
    // Named so the caller can tell "not yet built" from "LinkedIn said no".
    expect(outcome).toMatchObject({ meta: { blocker: 'media_upload_not_implemented' } });
    expect(sent).toEqual([]);
  });

  it('refuses an author URN that is not one', async () => {
    stubFetch({ status: 201 });

    for (const authorUrn of [
      '',
      'urn:li:person:',
      'FixtureMember',
      'urn:li:organization:123',
      'urn:li:person:has spaces',
    ]) {
      const outcome = await new LinkedInRestPublisher({ ...CONFIG, authorUrn }).publish(REQUEST);
      // A post with no valid author cannot be attributed to the member, and
      // sending it to find out would be the expensive way to learn that.
      expect(outcome.status, authorUrn).toBe('failed');
      expect(outcome, authorUrn).toMatchObject({ meta: { blocker: 'invalid_author_urn' } });
    }
    expect(sent).toEqual([]);
  });

  it('refuses an API version that is not YYYYMM', async () => {
    stubFetch({ status: 201 });

    for (const postsApiVersion of ['', '2026', '2026-05', 'latest', '20260']) {
      const outcome = await new LinkedInRestPublisher({ ...CONFIG, postsApiVersion }).publish(
        REQUEST,
      );
      expect(outcome.status, postsApiVersion).toBe('failed');
      expect(outcome, postsApiVersion).toMatchObject({ meta: { blocker: 'invalid_api_version' } });
    }
    expect(sent).toEqual([]);
  });
});

describe('a post it does send', () => {
  it('carries the approved text, the verified author and the pinned version', async () => {
    stubFetch({ status: 201, headers: { 'x-restli-id': 'urn:li:share:9001' } });

    const outcome = await new LinkedInRestPublisher(CONFIG).publish(REQUEST);

    expect(outcome).toMatchObject({ status: 'succeeded', post_urn: 'urn:li:share:9001' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.linkedin.com/rest/posts');

    const body = JSON.parse(String(sent[0]?.init?.body)) as {
      author: string;
      commentary: string;
      visibility: string;
      lifecycleState: string;
    };
    expect(body.author).toBe(CONFIG.authorUrn);
    expect(body.commentary).toBe(REQUEST.body_text);
    expect(body.visibility).toBe('PUBLIC');
    expect(body.lifecycleState).toBe('PUBLISHED');
  });

  it('sends the credential and the pinned API version, and nothing else revealing', async () => {
    stubFetch({ status: 201, headers: { 'x-restli-id': 'urn:li:share:9002' } });
    await new LinkedInRestPublisher(CONFIG).publish(REQUEST);

    const headers = Object.fromEntries(
      Object.entries((sent[0]?.init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );

    expect(headers['authorization']).toBe(`Bearer ${CONFIG.accessToken}`);
    // Pinned, so the request shape cannot change under the member without
    // anything in this repo moving.
    expect(headers['linkedin-version']).toBe('202605');

    // Idempotency is not a header here: the key is derived from the approval
    // and enforced against the local publications table, which is what stops a
    // replay before a socket is ever opened. Sending it upstream would add a
    // second, weaker guarantee that could disagree with the first.
    expect(JSON.stringify(headers)).not.toContain('idem-1');
  });
});

describe('an answer it cannot interpret', () => {
  it('calls a 201 with no identifier ambiguous, not a success', async () => {
    stubFetch({ status: 201 });

    const outcome = await new LinkedInRestPublisher(CONFIG).publish(REQUEST);

    // LinkedIn accepted it and did not say what it made. Reporting success
    // would give the member a receipt with nothing on it.
    expect(outcome.status).toBe('ambiguous');
    expect(outcome).toMatchObject({ meta: { http_status: 201 } });
  });

  it('calls a 5xx ambiguous, because the post may still have landed', async () => {
    for (const status of [500, 502, 503, 504]) {
      sent.length = 0;
      stubFetch({ status });
      const outcome = await new LinkedInRestPublisher(CONFIG).publish(REQUEST);
      expect(outcome.status, String(status)).toBe('ambiguous');
    }
  });

  it('calls a transport failure ambiguous rather than failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });

    const outcome = await new LinkedInRestPublisher(CONFIG).publish(REQUEST);
    expect(outcome.status).toBe('ambiguous');
  });
});

describe('an answer that is a definite rejection', () => {
  it('calls a 4xx failed, with the status in the message', async () => {
    stubFetch({ status: 422, body: { message: 'duplicate content' } });

    const outcome = await new LinkedInRestPublisher(CONFIG).publish(REQUEST);

    expect(outcome.status).toBe('failed');
    expect(JSON.stringify(outcome)).toContain('422');
  });

  it('tells the caller to close the lane on a 401 or a 403', async () => {
    const demotions: number[] = [];

    for (const status of [401, 403]) {
      sent.length = 0;
      stubFetch({ status });
      const outcome = await new LinkedInRestPublisher({
        ...CONFIG,
        onAuthorizationFailure: (code) => demotions.push(code),
      }).publish(REQUEST);

      expect(outcome.status, String(status)).toBe('failed');
    }

    // The credential is gone or the product was removed; the next attempt
    // should stop at the gate rather than send again with a dead token.
    expect(demotions).toEqual([401, 403]);
  });

  it('still reports a definite rejection when the demotion itself fails', async () => {
    stubFetch({ status: 401 });

    const outcome = await new LinkedInRestPublisher({
      ...CONFIG,
      onAuthorizationFailure: () => {
        throw new Error('the database is gone');
      },
    }).publish(REQUEST);

    // Failing to record the follow-up must not turn a definite rejection into
    // an ambiguous publish — that would send the member looking for a post
    // LinkedIn certainly refused.
    expect(outcome.status).toBe('failed');
  });

  it('does not call for a demotion on an ordinary rejection', async () => {
    const demotions: number[] = [];
    stubFetch({ status: 422 });

    await new LinkedInRestPublisher({
      ...CONFIG,
      onAuthorizationFailure: (code) => demotions.push(code),
    }).publish(REQUEST);

    // A rejected post says nothing about the credential.
    expect(demotions).toEqual([]);
  });
});
