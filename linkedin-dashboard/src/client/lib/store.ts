import { useCallback, useEffect, useState } from 'hono/jsx/dom';
import { api, ApiError } from './api.ts';

// Async reads, with the three states rendered rather than implied.
//
// The old client had none: switching screens showed an empty region until the
// fetch resolved, and any failure became a 12px string in the header corner.
// Here loading, ready and error are distinct and each screen renders all three.

export type Resource<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError };

export interface ResourceHandle<T> {
  state: Resource<T>;
  reload: () => void;
}

const LOADING = { status: 'loading', data: null, error: null } as const;

// The dashboard and MCP server are separate processes over one WAL database.
// A screen therefore refreshes while visible and immediately when the member
// returns to it, so an agent-created draft or decision appears without a full
// page reload. Only the mounted screen polls; hidden destinations do no work.
export const RESOURCE_SYNC_INTERVAL_MS = 15_000;

/**
 * Trails a fast-changing value, so a search box does not fire a request per
 * keystroke. Each of those was an FTS5 query plus a reset to the loading
 * skeleton, which made typing flicker as well as cost.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function useResource<T>(path: string, deps: unknown[] = []): ResourceHandle<T> {
  const [state, setState] = useState<Resource<T>>(LOADING);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Aborted on unmount and on every dependency change, so a slow response for
    // a screen the member has already left cannot overwrite a newer one.
    const controller = new AbortController();
    // Keep already-rendered data visible during background synchronization.
    // The first load and retries from an error still show their explicit state.
    setState((current) => (current.status === 'ready' ? current : LOADING));
    api
      .get<T>(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          data: null,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, {
                  code: 'INTERNAL',
                  message: error instanceof Error ? error.message : String(error),
                }),
        });
      });
    return () => controller.abort();
  }, [path, nonce, ...deps]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    };
    const timer = window.setInterval(refreshIfVisible, RESOURCE_SYNC_INTERVAL_MS);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [path]);

  return { state, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * A mutation, with its in-flight and failed states.
 *
 * Never optimistic. Displayed state changes only when the server has answered —
 * showing an approval as granted before the grant has actually committed would
 * be the interface lying about the one thing it exists to be trusted on.
 */
export interface Mutation {
  pending: boolean;
  error: ApiError | null;
  /**
   * Resolves with the response on success and `null` on failure.
   *
   * Typed as `T | null` rather than `unknown | null` — which collapses to
   * `unknown` and made every caller's `!== null` check narrow nothing.
   */
  run: <T = Record<string, unknown>>(
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<T | null>;
  clear: () => void;
}

export function useMutation(): Mutation {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  return {
    pending,
    error,
    clear: () => setError(null),
    run: async <T>(path: string, body: Record<string, unknown> = {}) => {
      setPending(true);
      setError(null);
      try {
        return await api.post<T>(path, body);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError(0, {
                code: 'INTERNAL',
                message: caught instanceof Error ? caught.message : String(caught),
              }),
        );
        return null;
      } finally {
        setPending(false);
      }
    },
  };
}
