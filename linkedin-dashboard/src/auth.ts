import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

// Dashboard security model (plan §6/§10):
//   - binds 127.0.0.1 only (the caller enforces this at listen time)
//   - per-launch CSPRNG token delivered via URL fragment (never logged by
//     servers/proxies), exchanged once for an HttpOnly SameSite=Strict cookie
//   - every /api route requires: exact Host allowlist (kills DNS rebinding),
//     Sec-Fetch-Site: same-origin (browser-enforced, unforgeable by page JS),
//     and a valid session cookie (except the exchange endpoint itself)
//   - tokens are stored hashed; comparisons are constant-time

export class DashboardAuth {
  readonly launchToken: string;
  readonly #launchTokenHash: Buffer;
  readonly #sessions = new Set<string>();
  #launchTokenSpent = false;
  readonly port: number;

  constructor(port: number) {
    this.port = port;
    this.launchToken = randomBytes(32).toString('base64url');
    this.#launchTokenHash = sha256(this.launchToken);
  }

  hostAllowed(host: string | undefined): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  exchangeToken(candidate: string): string | null {
    const candidateHash = sha256(candidate);
    // Compared before the spent check, so the timing of a wrong token does not
    // depend on whether the right one has already been used.
    const matches =
      candidateHash.length === this.#launchTokenHash.length &&
      timingSafeEqual(candidateHash, this.#launchTokenHash);
    if (!matches) return null;
    // Single use, as documented. The token is printed to the terminal and rides
    // in a URL fragment, so it can outlive the moment it was needed — in
    // scrollback, in a copied link, in a screen share. Anyone replaying it got
    // a fresh session for the life of the process; now the first exchange
    // spends it.
    if (this.#launchTokenSpent) return null;
    this.#launchTokenSpent = true;

    const sessionId = randomBytes(32).toString('base64url');
    this.#sessions.add(hashHex(sessionId));
    return sessionId;
  }

  sessionValid(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return this.#sessions.has(hashHex(sessionId));
  }
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}
function hashHex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export const SESSION_COOKIE = 'linkedin_mcp_session';

export function guard(auth: DashboardAuth, opts: { requireSession: boolean }) {
  return async (c: Context, next: Next) => {
    if (!auth.hostAllowed(c.req.header('host'))) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    const secFetchSite = c.req.header('sec-fetch-site');
    if (secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      // 'none' = direct navigation / address bar; page fetches are
      // 'same-origin'. Anything cross-site (hostile page, rebinding trick
      // that survived the Host check) is refused.
      return c.json({ error: 'forbidden_fetch_site' }, 403);
    }
    if (opts.requireSession && !auth.sessionValid(getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    await next();
  };
}

export function issueSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    // No 'secure' flag: loopback HTTP by design; the bind address is the
    // transport boundary.
  });
}
