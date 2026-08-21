// Typed access to the dashboard API.
//
// The old client reduced every failure to `body.error.message` and painted it
// into a 12px string in the header corner. The domain returns far more than
// that — a machine-readable `code`, the exact `blockers` that stopped the
// operation, whether it is worth retrying — and the capability layer writes
// remediation prose that is some of the clearest text in the product. All of it
// is preserved here and rendered in full.

export interface ApiErrorPayload {
  code: string;
  message: string;
  blockers?: string[];
  retryable?: boolean;
  dashboard_url?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly blockers: string[];
  readonly retryable: boolean;
  readonly status: number;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.blockers = payload.blockers ?? [];
    this.retryable = payload.retryable ?? false;
  }

  /** A dead session is a distinct condition: the fix is a new launch URL, not a retry. */
  get isSessionEnded(): boolean {
    return this.status === 401;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === 'string') {
    return new ApiError(status, { code: error.toUpperCase(), message: error });
  }
  if (error && typeof error === 'object') {
    const payload = error as Partial<ApiErrorPayload>;
    return new ApiError(status, {
      code: payload.code ?? 'INTERNAL',
      message: payload.message ?? `HTTP ${status}`,
      ...(payload.blockers ? { blockers: payload.blockers } : {}),
      ...(payload.retryable !== undefined ? { retryable: payload.retryable } : {}),
    });
  }
  return new ApiError(status, { code: 'INTERNAL', message: `HTTP ${status}` });
}

// Notified whenever any request comes back 401, from anywhere in the app.
//
// Sessions live in memory and the launch token is single-use, so a server
// restart ends every session at once — and in development `tsx watch` restarts
// on each server-file save. Without this, every screen independently reports
// "unauthenticated" and the member is left guessing; the shell needs to know
// once and say what to do about it.
const sessionEndedListeners = new Set<() => void>();

export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!response.ok) {
    const error = toApiError(response.status, await response.json().catch(() => null));
    if (error.isSessionEnded) {
      for (const listener of sessionEndedListeners) listener();
    }
    throw error;
  }
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, signal ? { signal } : {}),

  /**
   * Every mutation carries `confirm: true` explicitly. The session cookie is
   * already SameSite=Strict and the guard already requires same-origin, so this
   * is belt and braces — but it also means no mutation can be triggered by a
   * bare URL, and the server rejects anything that arrives without it.
   */
  post: <T>(path: string, body: Record<string, unknown> = {}): Promise<T> =>
    request<T>(path, { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),

  /**
   * Multipart, so it cannot go through `post`: setting a content-type by hand
   * would strip the boundary the browser generates. The guard still applies —
   * same-origin, session cookie, SameSite=Strict.
   */
  upload: <T>(path: string, form: FormData): Promise<T> =>
    request<T>(path, { method: 'POST', body: form }),
};

const LAUNCH_TOKEN_KEY = 't';

/**
 * Exchanges the single-use launch token from the URL fragment for a session
 * cookie, then strips it from the address bar.
 *
 * The token rides in the fragment precisely so it never reaches a server log,
 * and it is spent on first exchange — so this runs once and the hash is
 * immediately rewritten to a route.
 */
export async function establishSession(): Promise<boolean> {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const token = new URLSearchParams(hash).get(LAUNCH_TOKEN_KEY);
  if (token) {
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (response.ok) return true;
    } catch {
      // The shell turns false into the explicit session-ended recovery state.
      // A rejected fetch must not leave the app stuck on a blank checking view.
    } finally {
      // Strip the bearer token even when the exchange fails; leaving it in the
      // address bar or history would extend its exposure without helping retry.
      //
      // Stripped to nothing rather than rewritten to `#/overview`. A launch URL
      // carries a credential, not a destination, and an empty hash already
      // resolves to Overview through DEFAULT_ROUTE — so naming the route bought
      // nothing and cost the shell its one signal that the member had not asked
      // for anywhere in particular. Reading `#/overview` as a request, the
      // first-run redirect stood down on exactly the run it exists for, and the
      // Setup screen was reachable only on a second visit.
      history.replaceState(null, '', location.pathname);
    }
  }
  // No token, or a spent one: a cookie from an earlier exchange may still be
  // good. Ask the cheapest authenticated endpoint — a HEAD-shaped probe rather
  // than a real read, so it costs nothing beyond the round trip.
  try {
    const probe = await fetch('/api/session/check');
    return probe.ok;
  } catch {
    return false;
  }
}
