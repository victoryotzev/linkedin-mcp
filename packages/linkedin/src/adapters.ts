import { LINKEDIN_API_HOST, assertLinkedInUrl } from './dmaClient.ts';
import type { PublishOutcome, PublishRequest, Publisher } from './index.ts';

export interface LinkedInConfig {
  accessToken: string;
  authorUrn: string;
  // Posts API versions retire on a ~12-month cycle, so the version lives in
  // configuration and is bumped by the user after reading LinkedIn's changelog.
  postsApiVersion: string;
  // The DMA endpoints are pinned: anything other than 202312 returns 426.
  readonly dmaApiVersion: '202312';
  /** Test seam. Production uses the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Lets the application close a proven-bad write lane without coupling this adapter to SQLite. */
  onAuthorizationFailure?: (status: 401 | 403) => void;
}

// Snapshot domains this product will read. Everything outside the allow list is
// refused, and the block list names the ones that are refused loudly because
// they carry other people's data or credentials rather than the member's work
// history.
export const DMA_ALLOWED_DOMAINS = [
  'PROFILE',
  'POSITIONS',
  'EDUCATION',
  'SKILLS',
  'CERTIFICATIONS',
  'COURSES',
  'HONORS',
  'LANGUAGES',
  'PROJECTS',
  'PUBLICATIONS',
  'MEMBER_SHARE_INFO',
  'ARTICLES',
] as const;

export const DMA_BLOCKED_DOMAINS = [
  'INBOX',
  'CONNECTIONS',
  'CONTACTS',
  'INVITATIONS',
  'PHONE_NUMBERS',
  'EMAIL_ADDRESSES',
  'LOGIN',
  'SECURITY_CHALLENGE_PIPE',
  'RECEIPTS',
  'ADS_CLICKED',
  'AD_TARGETING',
  'INFERENCE_TAKEOUT',
] as const;

// POST /rest/posts. Self-serve `w_member_social` can create posts but cannot
// read them back, which is why publication outcomes are reconciled rather than
// polled.
export class LinkedInRestPublisher implements Publisher {
  readonly name = 'linkedin_rest' as const;

  constructor(private readonly config: LinkedInConfig) {}

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    if (request.media.length > 0) {
      return {
        status: 'failed',
        error: 'live media publishing is not available yet; remove media or use dry-run publishing',
        meta: { blocker: 'media_upload_not_implemented' },
      };
    }
    if (!/^urn:li:person:[A-Za-z0-9_-]+$/.test(this.config.authorUrn)) {
      return {
        status: 'failed',
        error: 'the verified write lane has no valid LinkedIn person URN; verify it again',
        meta: { blocker: 'invalid_author_urn' },
      };
    }
    if (!/^\d{6}$/.test(this.config.postsApiVersion)) {
      return {
        status: 'failed',
        error: 'LinkedIn Posts API version must use YYYYMM format',
        meta: { blocker: 'invalid_api_version' },
      };
    }

    const url = `${LINKEDIN_API_HOST}/rest/posts`;
    assertLinkedInUrl(url);
    const body = {
      author: this.config.authorUrn,
      commentary: request.body_text,
      visibility: request.visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
          'linkedin-version': this.config.postsApiVersion,
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify(body),
      });
    } catch {
      return {
        status: 'ambiguous',
        reason:
          'the LinkedIn request ended without a response; check account activity before doing anything else',
        meta: { blocker: 'network_outcome_unknown' },
      };
    }

    const postUrn = response.headers.get('x-restli-id');
    if (response.status === 201 && postUrn) {
      return { status: 'succeeded', post_urn: postUrn, meta: { http_status: 201 } };
    }
    if (
      response.status === 201 ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return {
        status: 'ambiguous',
        reason:
          response.status === 201
            ? 'LinkedIn accepted the post but omitted its identifier; check account activity before doing anything else'
            : `LinkedIn returned HTTP ${response.status}; the final publishing outcome is unknown`,
        meta: { http_status: response.status },
      };
    }
    if (response.status === 401 || response.status === 403) {
      try {
        this.config.onAuthorizationFailure?.(response.status);
      } catch {
        // The HTTP outcome is still a definite rejection. Failure to persist
        // the follow-up demotion must not turn it into an ambiguous publish.
      }
    }
    return {
      status: 'failed',
      error: `LinkedIn rejected the post with HTTP ${response.status}`,
      meta: { http_status: response.status },
    };
  }
}
