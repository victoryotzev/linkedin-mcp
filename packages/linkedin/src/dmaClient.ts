import { setTimeout as sleep } from 'node:timers/promises';
import { DomainError } from '@linkedin-mcp/shared';
import { DMA_ALLOWED_DOMAINS, DMA_BLOCKED_DOMAINS } from './adapters.ts';

// Live EU Data Portability read lane. Every call is a GET against one pinned
// host carrying a bearer token, so the two things that matter here are that the
// token never reaches a message and that the host can never change underneath
// us. The capability gate upstream decides whether any of this may run at all.

export const LINKEDIN_API_HOST = 'https://api.linkedin.com';

// Pinned by LinkedIn: the DMA endpoints reject every other value with 426.
const DMA_API_VERSION = '202312';
const RESTLI_PROTOCOL_VERSION = '2.0.0';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const BODY_SNIPPET_MAX = 300;

// Snapshot has no end-of-collection marker; the walk ends on a sentinel error
// instead. The cap bounds the damage if LinkedIn ever reworks that sentinel —
// without it a changed message means an unbounded request loop.
const MAX_SNAPSHOT_PAGES = 200;
const SNAPSHOT_PAGE_SIZE = 10;
// The documentation quotes this sentinel as "No data found for this memberId",
// but the live API says "No data found for this domain and memberId." Matching
// the documented string exactly meant the sentinel never fired and every walk
// died on its own terminator, so the match is deliberately loose about the
// middle of the phrase and tight about the status code instead.
const NO_MORE_SNAPSHOT_DATA = /no data found/i;

const CHANGELOG_MIN_COUNT = 1;
const CHANGELOG_MAX_COUNT = 50;
const MAX_CHANGELOG_PAGES = 200;

export interface DmaClientConfig {
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export interface SnapshotPage {
  domain: string;
  rows: Array<Record<string, unknown>>;
}

export interface HttpFailure {
  readonly status: number;
  // Already token-redacted, and deliberately untruncated so end-of-data
  // sentinels stay matchable; truncation happens when a message is built.
  readonly body: string;
}

export type HttpResult =
  | { readonly ok: true; readonly json: unknown }
  | ({ readonly ok: false } & HttpFailure);

// The bearer token rides on every request, so the host is checked twice: on the
// URL we build and on the URL the response actually came from. A followed
// redirect would hand the token to whoever sent the 30x.
export function assertLinkedInUrl(url: string): void {
  if (!url.startsWith(`${LINKEDIN_API_HOST}/`)) {
    throw new DomainError('INVALID_INPUT', `refusing to call a non-LinkedIn host: ${url}`, {
      blockers: ['host_not_pinned'],
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// LinkedIn echoes request context into some error envelopes, so the token is
// stripped before the body can reach a message, a log line or an MCP result.
// Redaction runs before truncation: slicing first can leave half a token behind.
function redact(body: string, token: string): string {
  return token.length > 0 ? body.split(token).join('[redacted]') : body;
}

function snippet(body: string): string {
  if (body === '') return '';
  const text = body.length > BODY_SNIPPET_MAX ? `${body.slice(0, BODY_SNIPPET_MAX)}…` : body;
  return ` — ${text}`;
}

function parseJson(body: string, token: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DomainError(
      'INTERNAL',
      `LinkedIn returned a body that is not JSON${snippet(redact(body, token))}`,
      { blockers: ['malformed_response'] },
    );
  }
}

function retryAfterMs(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const raw = headerValue.trim();
  if (raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const deadline = Date.parse(raw);
  if (Number.isNaN(deadline)) return undefined;
  return Math.min(Math.max(deadline - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

// Full jitter rather than a fixed schedule: DMA limits are undocumented, and a
// dashboard sync plus a tool call retrying in lockstep is how one 429 becomes
// three.
function backoffMs(attempt: number): number {
  return Math.round(Math.random() * BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

// GET-only by construction. A retried write is a duplicate write, and this lane
// has no business writing anything.
export async function linkedInGet(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  token: string,
): Promise<HttpResult> {
  assertLinkedInUrl(url);
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error' });
    } catch (err) {
      throw new DomainError(
        'INTERNAL',
        `the LinkedIn request failed before a response arrived: ${redact(
          err instanceof Error ? err.message : String(err),
          token,
        )}`,
        { blockers: ['network_error'], retryable: true },
      );
    }
    if (response.url !== '') assertLinkedInUrl(response.url);

    const body = redact(await response.text(), token);
    if (response.ok) {
      return { ok: true, json: body === '' ? null : parseJson(body, token) };
    }
    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt));
      continue;
    }
    return { ok: false, status: response.status, body };
  }
  // The loop has no exit condition: every path returns or throws, and the
  // retry branch is the only one that continues.
  /* v8 ignore next */
}

// 401 and 403 stay distinguishable on purpose: the first demotes the capability
// to 'expired' (re-mint the token), the second to 'blocked' (the app is missing
// a product or scope). Collapsing them sends the member to the wrong fix.
export function httpFailureToDomainError(failure: HttpFailure, what: string): DomainError {
  const detail = snippet(failure.body);
  switch (failure.status) {
    case 400:
      return new DomainError(
        'INVALID_INPUT',
        `LinkedIn rejected the request while ${what} (400)${detail}`,
        { blockers: ['bad_request'] },
      );
    case 401:
      return new DomainError(
        'CAPABILITY_UNAVAILABLE',
        `LinkedIn rejected the access token while ${what} (401): the token expired or was revoked. Mint a fresh one with the Developer Portal Token Generator, paste it in the dashboard, and re-verify the capability${detail}`,
        { blockers: ['token_expired_or_revoked'] },
      );
    case 403:
      return new DomainError(
        'CAPABILITY_UNAVAILABLE',
        `LinkedIn refused ${what} (403): the app is missing the required product or scope. Add it in the Developer Portal, re-mint the token, then re-verify the capability${detail}`,
        { blockers: ['product_or_scope_missing'] },
      );
    case 404:
      return new DomainError(
        'NOT_FOUND',
        `LinkedIn has nothing to return while ${what} (404)${detail}`,
        { blockers: ['upstream_not_found'] },
      );
    case 426:
      return new DomainError(
        'CAPABILITY_UNAVAILABLE',
        `LinkedIn rejected the pinned API version ${DMA_API_VERSION} while ${what} (426): the DMA lane needs a version bump before it can run again. Check LinkedIn's changelog and update the pin${detail}`,
        { blockers: ['stale_api_version'] },
      );
    case 429:
      return new DomainError(
        'INTERNAL',
        `LinkedIn rate-limited ${what} (429) and did not recover within ${MAX_ATTEMPTS} attempts; DMA limits are undocumented, so retry by hand later rather than sooner${detail}`,
        { blockers: ['rate_limited'], retryable: true },
      );
    default:
      return new DomainError(
        'INTERNAL',
        `LinkedIn returned ${failure.status} while ${what}${detail}`,
        { blockers: ['upstream_error'], retryable: failure.status >= 500 },
      );
  }
}

// { elements: [ { snapshotDomain, snapshotData: [...] } ] }. Elements carrying
// some other domain are dropped: an allowlisted request must not become a way
// to receive a blocked domain's rows.
function snapshotRows(json: unknown, domain: string): Array<Record<string, unknown>> {
  const elements = isRecord(json) ? json['elements'] : undefined;
  if (!Array.isArray(elements)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const element of elements) {
    if (!isRecord(element)) continue;
    const elementDomain = element['snapshotDomain'];
    if (typeof elementDomain === 'string' && elementDomain !== domain) continue;
    const data = element['snapshotData'];
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      if (isRecord(row)) rows.push(row);
    }
  }
  return rows;
}

function elementsOf(json: unknown): Array<Record<string, unknown>> {
  const elements = isRecord(json) ? json['elements'] : undefined;
  if (!Array.isArray(elements)) return [];
  return elements.filter(isRecord);
}

export class DmaClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(config: DmaClientConfig) {
    if (config.accessToken.trim() === '') {
      throw new DomainError(
        'INVALID_INPUT',
        'a LinkedIn access token is required before the DMA lane can run; paste one in the dashboard (Capabilities area) and verify the capability',
        { blockers: ['no_access_token'] },
      );
    }
    this.#token = config.accessToken;
    // Node's global fetch is undici. Importing the package by name would add a
    // dependency the workspace does not carry.
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
  }

  assertDomainAllowed(domain: string): void {
    if ((DMA_BLOCKED_DOMAINS as readonly string[]).includes(domain)) {
      throw new DomainError(
        'INVALID_INPUT',
        `domain ${domain} holds third-party or credential-adjacent data and is excluded by default`,
        { blockers: ['domain_not_allowlisted'] },
      );
    }
    if (!(DMA_ALLOWED_DOMAINS as readonly string[]).includes(domain)) {
      throw new DomainError('INVALID_INPUT', `domain ${domain} is not in the allowlist`, {
        blockers: ['domain_not_allowlisted'],
      });
    }
  }

  // Walks every page of one snapshot domain. The allowlist check runs before
  // anything is built, so a blocked domain never reaches the network.
  async fetchSnapshotDomain(domain: string): Promise<SnapshotPage> {
    this.assertDomainAllowed(domain);
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 0; page < MAX_SNAPSHOT_PAGES; page++) {
      // `start` is a PAGE INDEX here, not a row offset: LinkedIn's own sample
      // answers a count=10 request with a next link of start=1, then start=2.
      // Multiplying by the page size skips nine pages out of ten and silently
      // imports a fraction of the domain as if it were the whole of it.
      const url =
        `${LINKEDIN_API_HOST}/rest/memberSnapshotData?q=criteria` +
        `&domain=${encodeURIComponent(domain)}` +
        `&start=${page}&count=${SNAPSHOT_PAGE_SIZE}`;
      const result = await linkedInGet(url, this.#dmaHeaders(), this.#fetch, this.#token);
      if (!result.ok) {
        // Walking off the end of a domain is reported as an error rather than
        // an empty page. Treating it as a failure would abort every import at
        // the last page instead of finishing it. The same 404 answers a domain
        // LinkedIn has not finished assembling yet, which is why page 0 coming
        // back empty is a distinct, reportable state rather than a failure.
        // Any 4xx carrying the sentinel ends the walk: the live API answers 404
        // and the documentation's sample shows 400, so pinning one status would
        // turn the other into a crash. A 5xx never terminates a walk quietly —
        // that would report a server outage as a complete import.
        const clientError = result.status >= 400 && result.status < 500;
        if (clientError && NO_MORE_SNAPSHOT_DATA.test(result.body)) return { domain, rows };
        throw httpFailureToDomainError(result, `reading the ${domain} snapshot`);
      }
      const pageRows = snapshotRows(result.json, domain);
      if (pageRows.length === 0) return { domain, rows };
      rows.push(...pageRows);
    }
    throw new DomainError(
      'INTERNAL',
      `the ${domain} snapshot did not terminate within ${MAX_SNAPSHOT_PAGES} pages; the partial result is discarded rather than imported as complete`,
      { blockers: ['snapshot_page_cap'] },
    );
  }

  // The changelog window is a rolling 28 days and LinkedIn silently clamps an
  // older startTime, so a gap can never be repaired by asking again — rows have
  // to be persisted as they arrive.
  async fetchChangelog(
    sinceMs: number,
    count = CHANGELOG_MAX_COUNT,
  ): Promise<Array<Record<string, unknown>>> {
    if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
      throw new DomainError(
        'INVALID_INPUT',
        `changelog startTime must be a non-negative epoch-milliseconds integer, got ${String(sinceMs)}`,
        { blockers: ['bad_start_time'] },
      );
    }
    if (!Number.isInteger(count) || count < CHANGELOG_MIN_COUNT || count > CHANGELOG_MAX_COUNT) {
      throw new DomainError(
        'INVALID_INPUT',
        `changelog count must be an integer in [${CHANGELOG_MIN_COUNT}, ${CHANGELOG_MAX_COUNT}], got ${String(count)}`,
        { blockers: ['bad_count'] },
      );
    }
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 0; page < MAX_CHANGELOG_PAGES; page++) {
      const url =
        `${LINKEDIN_API_HOST}/rest/memberChangeLogs?q=memberAndApplication` +
        `&start=${page * count}&count=${count}&startTime=${sinceMs}`;
      const result = await linkedInGet(url, this.#dmaHeaders(), this.#fetch, this.#token);
      if (!result.ok) {
        throw httpFailureToDomainError(result, 'reading the member changelog');
      }
      const pageRows = elementsOf(result.json);
      rows.push(...pageRows);
      // LinkedIn's documented offset pagination contract defines a short page
      // as the end of the collection. We intentionally do not advance a local
      // watermark until this complete walk returns.
      if (pageRows.length < count) return rows;
    }
    throw new DomainError(
      'INTERNAL',
      `the member changelog did not terminate within ${MAX_CHANGELOG_PAGES} pages; the partial result is discarded and the watermark is not advanced`,
      { blockers: ['changelog_page_cap'] },
    );
  }

  #dmaHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      'LinkedIn-Version': DMA_API_VERSION,
      'X-Restli-Protocol-Version': RESTLI_PROTOCOL_VERSION,
    };
  }
}
