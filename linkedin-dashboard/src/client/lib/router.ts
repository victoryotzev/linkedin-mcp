import { useSyncExternalStore } from 'hono/jsx/dom';

// Hash routing, deliberately.
//
// The launch flow puts a single-use token in the URL fragment
// (`/#t=<token>`), which the client exchanges for a session cookie and then
// strips. Hash routing keeps that flow intact and needs no new server routes —
// history routing would require every deep link to be served by the shell,
// which is more surface on the one authenticated local origin for no gain.

export const DESTINATIONS = [
  'setup',
  'overview',
  'evidence',
  'profile',
  'content',
  'publishing',
  'system',
] as const;

export type Destination = (typeof DESTINATIONS)[number];

/**
 * One name per destination, for the rail, the page heading and the command
 * palette alike. These lived in two places — `AppShell`'s META and a separate
 * `DESTINATION_LABELS` in commands.ts — keyed by the same union and free to
 * drift apart. The hint that goes with each label stays in AppShell, because
 * only the page heading has room for it.
 */
export const DESTINATION_LABELS: Record<Destination, string> = {
  setup: 'Setup',
  overview: 'Overview',
  evidence: 'Evidence',
  profile: 'Profile',
  content: 'Content',
  publishing: 'Publishing',
  system: 'System',
};

export const DEFAULT_ROUTE: Route = { destination: 'overview', view: null, id: null };

export interface Route {
  destination: Destination;
  /** Sub-view within a destination, e.g. `queue` in `#/evidence/queue`. */
  view: string | null;
  /** Detail selection, from `?id=`. Names a record within the view, not a page. */
  id: string | null;
}

const isDestination = (value: string): value is Destination =>
  (DESTINATIONS as readonly string[]).includes(value);

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (raw.length === 0) return DEFAULT_ROUTE;

  const [pathPart = '', queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  if (!isDestination(first)) return DEFAULT_ROUTE;

  const id = queryPart ? new URLSearchParams(queryPart).get('id') : null;
  return { destination: first, view: segments[1] ?? null, id };
}

export function routeToHash(route: Partial<Route> & { destination: Destination }): string {
  const view = route.view ? `/${route.view}` : '';
  const query = route.id ? `?id=${encodeURIComponent(route.id)}` : '';
  return `#/${route.destination}${view}${query}`;
}

function subscribe(onChange: () => void): () => void {
  addEventListener('hashchange', onChange);
  return () => removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => location.hash,
    () => '',
  );
  return parseHash(hash);
}

export function navigate(route: Partial<Route> & { destination: Destination }): void {
  location.hash = routeToHash(route);
}

// Selection travels as `?id=` inside the fragment, deliberately kept apart from
// the `#t=<token>` launch format above: a token is a credential the client
// swallows and strips, an id is a bookmark meant to be shared. Two syntaxes so
// neither can be mistaken for the other, and so a route with no selection stays
// a bare `#/destination/view`.

/** The current detail selection, or null. */
export function useSelectedId(): string | null {
  return useRoute().id;
}

/**
 * Select (or clear) the detail record on the current destination and view.
 *
 * Reads the live hash rather than taking the route as an argument, so a click
 * handler deep in a screen can move the selection without every caller having
 * to thread the route down to it.
 */
export function selectId(id: string | null): void {
  const { destination, view } = parseHash(location.hash);
  navigate({ destination, view, id });
}
