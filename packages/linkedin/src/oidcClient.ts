import { DomainError } from '@linkedin-mcp/shared';
import { LINKEDIN_API_HOST, httpFailureToDomainError, linkedInGet } from './dmaClient.ts';

// GET /v2/userinfo. The `sub` claim is the only self-serve way to learn the
// author URN a post needs, which is why identity lookup is a capability of its
// own rather than a step inside publishing.
//
// The transport is shared with the DMA lane deliberately: the host pin and the
// 401/403 mapping have exactly one definition, and a second copy is a second
// place for the pin to drift.

export interface OidcIdentity {
  sub: string;
  person_urn: string;
  name: string | null;
  email: string | null;
}

export interface OidcClientConfig {
  accessToken: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// LinkedIn sends `name` for most members but only the parts for some locales.
function displayName(claims: Record<string, unknown>): string | null {
  const full = asString(claims['name']);
  if (full !== null) return full;
  const parts = [asString(claims['given_name']), asString(claims['family_name'])].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

export class OidcClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(config: OidcClientConfig) {
    if (config.accessToken.trim() === '') {
      throw new DomainError(
        'INVALID_INPUT',
        'a LinkedIn access token is required before identity lookup can run; paste one in the dashboard (Capabilities area) and verify the capability',
        { blockers: ['no_access_token'] },
      );
    }
    this.#token = config.accessToken;
    // Node's global fetch is undici. Importing the package by name would add a
    // dependency the workspace does not carry.
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
  }

  async fetchIdentity(): Promise<OidcIdentity> {
    const url = `${LINKEDIN_API_HOST}/v2/userinfo`;
    // /v2/userinfo is unversioned: sending LinkedIn-Version here earns a 426,
    // so the DMA header set is not reused even though the token is the same.
    const result = await linkedInGet(
      url,
      { Authorization: `Bearer ${this.#token}` },
      this.#fetch,
      this.#token,
    );
    if (!result.ok) {
      throw httpFailureToDomainError(result, 'reading the OIDC identity');
    }

    const claims = isRecord(result.json) ? result.json : {};
    const sub = asString(claims['sub']);
    if (sub === null) {
      throw new DomainError(
        'INTERNAL',
        'the OIDC userinfo response carried no `sub` claim, so no author URN can be derived from it',
        { blockers: ['missing_sub'] },
      );
    }
    return {
      sub,
      person_urn: `urn:li:person:${sub}`,
      name: displayName(claims),
      // `email` is absent whenever the app lacks the email scope; that is a
      // normal identity, not a failure.
      email: asString(claims['email']),
    };
  }
}
