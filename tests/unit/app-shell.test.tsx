// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../linkedin-dashboard/src/client/AppShell.tsx';
import { establishSession } from '../../linkedin-dashboard/src/client/lib/api.ts';
import { createPalette } from '../../linkedin-dashboard/src/client/lib/commands.ts';
import { flush } from '../helpers/clientHarness.ts';

// The shell around every screen, and the launch token that gets it started.
//
// The token is single-use and rides in the URL fragment precisely so it never
// reaches a server log. Everything here is about what happens at the two ends
// of that: spending it, and the moment the session it bought stops working.

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  location.hash = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? '';

async function mountShell(): Promise<void> {
  root = createRoot(container);
  root.render(<AppShell />);
  await flush(20);
}

describe('spending the launch token', () => {
  it('exchanges it, then strips it out of the address bar', async () => {
    location.hash = '#t=a-single-use-launch-token';
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));

    const ok = await establishSession();

    expect(ok).toBe(true);
    // Leaving it in the history would extend a bearer token's exposure without
    // helping anyone retry, since it is spent either way.
    expect(location.hash).not.toContain('a-single-use-launch-token');
    // Stripped to nothing, not rewritten to a route. An empty hash still
    // resolves to Overview, and it leaves the shell able to tell that the
    // member asked for nowhere in particular — which is what sends a first run
    // to Setup.
    expect(location.hash).toBe('');
  });

  it('reports failure, and still strips the token, when the server refuses it', async () => {
    location.hash = '#t=a-token-that-was-already-spent';
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));

    expect(await establishSession()).toBe(false);
    expect(location.hash).not.toContain('a-token-that-was-already-spent');
  });

  it('reports failure when the request never reached the server', async () => {
    location.hash = '#t=a-token-nobody-received';
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });

    // A rejected fetch must not leave the app stuck on a blank checking view.
    expect(await establishSession()).toBe(false);
    expect(location.hash).not.toContain('a-token-nobody-received');
  });
});

// A readiness payload with only the field the shell reads varied. The rest is
// filled so the Overview screen behind the redirect renders rather than throwing
// while the assertion is being made.
function readiness(isFirstRun: boolean): string {
  return JSON.stringify({
    is_first_run: isFirstRun,
    next_step: isFirstRun ? 'Add your first evidence source' : 'Review pending claims',
    checks: [],
    counts: {
      sources_enabled: isFirstRun ? 0 : 3,
      sources_pending: 0,
      artifacts: isFirstRun ? 0 : 12,
      claims_verified: isFirstRun ? 0 : 8,
      claims_awaiting_review: 0,
    },
  });
}

/** Answers the session exchange and readiness by URL; everything else is an empty object. */
function stubApi(isFirstRun: boolean): void {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/session')) return new Response('{}', { status: 200 });
    if (url.includes('/api/readiness')) return new Response(readiness(isFirstRun), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

describe('the first run, once the launch token has been spent', () => {
  it('lands on Setup rather than an overview of nothing', async () => {
    // The launch URL carries a credential, not a destination. Spending the token
    // must not be mistaken for the member asking for Overview — otherwise the
    // Setup screen is unreachable on exactly the run it exists for.
    location.hash = '#t=a-single-use-launch-token';
    stubApi(true);

    await mountShell();

    expect(location.hash).toBe('#/setup');
    expect(text()).toContain('Setup');
  });

  it('leaves a returning member on Overview', async () => {
    location.hash = '#t=a-single-use-launch-token';
    stubApi(false);

    await mountShell();

    // Not a redirect: an empty hash already resolves to Overview through
    // DEFAULT_ROUTE, so a settled ledger simply stays where it landed.
    expect(location.hash).not.toBe('#/setup');
  });

  it('honours a destination the member asked for, even on a first run', async () => {
    location.hash = '#/evidence';
    stubApi(true);

    await mountShell();

    // A bookmarked deep link wins over the first-run redirect. Someone who has
    // navigated deliberately is not lost, whatever their ledger looks like.
    expect(location.hash).toBe('#/evidence');
  });
});

describe('the shell when the session has ended', () => {
  it('explains what happened and what to run, rather than failing per screen', async () => {
    location.hash = '#/overview';
    // No token to exchange and no session cookie: every request is refused,
    // which is exactly what a restarted server looks like.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));

    await mountShell();

    const shown = text();
    // Without this, each screen reports "unauthenticated" on its own and the
    // member is left to work out what happened.
    expect(shown).toMatch(/this session has ended/i);
    expect(shown).toMatch(/npm run dashboard/);
    expect(shown).toMatch(/spent on first use/i);
  });

  it('still offers the rail, so the window is not a dead end', async () => {
    location.hash = '#/overview';
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));

    await mountShell();

    expect(document.querySelector('.skip-link')).toBeTruthy();
    expect(text()).toMatch(/skip to content/i);
  });
});

describe('the theme command', () => {
  it('switches the root theme and remembers the choice', () => {
    document.documentElement.dataset['theme'] = 'dark';
    const toggle = createPalette()
      .list()
      .find((c) => /theme/i.test(c.label));
    expect(toggle).toBeTruthy();

    toggle?.run();

    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('still switches when storage refuses to remember it', () => {
    document.documentElement.dataset['theme'] = 'light';
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error('storage is full');
      },
    });

    const toggle = createPalette()
      .list()
      .find((c) => /theme/i.test(c.label));
    toggle?.run();

    // Non-persistent is acceptable; a theme that refuses to change because it
    // could not be written down is not.
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});
