import { DmaClient, OidcClient } from '@linkedin-mcp/linkedin';
import { DomainError } from '@linkedin-mcp/shared';
import type { Lane } from './tokenService.ts';

export type ProbeResult =
  | { ok: true; person_urn?: string; warnings?: string[] }
  | { ok: false; status: number; message: string; retryable?: boolean };

// Proving a credential works has to use an endpoint the lane actually has.
// The read-lane app is bound to the Data Portability company page, so it has no
// Sign In with LinkedIn product and /v2/userinfo would 403 there — the probe
// must be a real DMA read instead. The write-lane app is the reverse.
export async function probeLane(lane: Lane, token: string): Promise<ProbeResult> {
  try {
    if (lane === 'write') {
      const identity = await new OidcClient({ accessToken: token }).fetchIdentity();
      return { ok: true, person_urn: identity.person_urn };
    }
    // A single cheap domain is enough to prove the product is live; PROFILE is
    // the smallest and is always present for a member.
    const page = await new DmaClient({ accessToken: token }).fetchSnapshotDomain('PROFILE');
    // An empty PROFILE does not mean a bad token — it means LinkedIn answered,
    // resolved the member id, and has nothing yet. It only begins assembling
    // historical data at first consent, so a token minted minutes ago reads
    // empty across every domain. The credential is proven; the lane is not.
    if (page.rows.length === 0) return { ok: true, warnings: ['snapshot_not_ready'] };
    return { ok: true };
  } catch (err) {
    if (err instanceof DomainError) {
      // The client tags failures by cause; map those back to the HTTP
      // meaning the capability demotion cares about.
      const status = err.blockers.includes('token_expired_or_revoked')
        ? 401
        : err.blockers.includes('product_or_scope_missing')
          ? 403
          : 0;
      // A dropped connection, a 429 or a LinkedIn 5xx says nothing about the
      // credential. Demoting on those turned a moment of bad connectivity into
      // a lane the member had to re-verify by hand, and demotion is what
      // requireCapability reads — so a blip closed the lane until someone
      // noticed.
      const retryable =
        status === 0 &&
        (err.retryable === true ||
          err.blockers.some((b) =>
            ['network_error', 'rate_limited', 'upstream_error'].includes(b),
          ));
      return { ok: false, status, message: err.message, retryable };
    }
    // A non-DomainError here is almost always a transport failure (DNS, socket
    // reset, TLS). Treat it as transient rather than as a revoked credential.
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}
