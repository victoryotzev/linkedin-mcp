// Publisher port. Adapters implement this; the domain never imports a
// concrete adapter, so the real LinkedIn client cannot be reached by accident.

export interface PublishRequest {
  idempotency_key: string;
  body_text: string;
  visibility: string;
  media: Array<{ artifact_id: string; alt: string }>;
  account_id: string;
}

export type PublishOutcome =
  | { status: 'succeeded'; post_urn: string; meta?: Record<string, unknown> }
  | { status: 'failed'; error: string; meta?: Record<string, unknown> }
  // Sent, but the response never arrived: LinkedIn may or may not have the
  // post. Never auto-retried — that is the double-post vector.
  | { status: 'ambiguous'; reason: string; meta?: Record<string, unknown> };

export interface Publisher {
  readonly name: 'dry_run' | 'linkedin_rest';
  publish(request: PublishRequest): Promise<PublishOutcome>;
}

// Exercises the entire approval/audit/idempotency machinery without touching
// the network. It remains useful even when the live text publisher is enabled.
export class DryRunPublisher implements Publisher {
  readonly name = 'dry_run' as const;
  readonly #seen = new Map<string, PublishOutcome>();

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const previous = this.#seen.get(request.idempotency_key);
    if (previous) return previous;
    const outcome: PublishOutcome = {
      status: 'succeeded',
      post_urn: `urn:li:share:dryrun-${request.idempotency_key.slice(0, 16)}`,
      meta: { simulated: true, chars: request.body_text.length },
    };
    this.#seen.set(request.idempotency_key, outcome);
    return outcome;
  }
}

export {
  DMA_ALLOWED_DOMAINS,
  DMA_BLOCKED_DOMAINS,
  LinkedInRestPublisher,
  type LinkedInConfig,
} from './adapters.ts';
export {
  DmaClient,
  LINKEDIN_API_HOST,
  assertLinkedInUrl,
  httpFailureToDomainError,
  linkedInGet,
  type DmaClientConfig,
  type HttpFailure,
  type HttpResult,
  type SnapshotPage,
} from './dmaClient.ts';
export { OidcClient, type OidcClientConfig, type OidcIdentity } from './oidcClient.ts';
