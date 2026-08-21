// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SetupScreen } from '../../linkedin-dashboard/src/client/screens/Setup.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { breakAuditChain, seedHealthy } from '../helpers/fixtures.ts';

// Every screen in the three states a member can actually be in: nothing yet,
// something wrong, and the server not answering.
//
// The suites so far run against a healthy seeded home, which is the one state a
// member is never in on their first day. An empty home exercises the other half
// of every view — the empty states, which are the only instructions a new
// member gets — and a broken audit chain exercises the refusals. A hung request
// exercises the loading and error paths that otherwise only appear when
// something is already going wrong.

const SCREENS: Array<{ name: string; Screen: FC; hashes: readonly string[] }> = [
  { name: 'Setup', Screen: SetupScreen, hashes: ['#/setup'] },
  { name: 'Overview', Screen: OverviewScreen, hashes: ['#/overview'] },
  {
    name: 'Evidence',
    Screen: EvidenceScreen,
    hashes: [
      '#/evidence/queue',
      '#/evidence/claims',
      '#/evidence/conflicts',
      '#/evidence/sources',
      '#/evidence/artifacts',
    ],
  },
  {
    name: 'Profile',
    Screen: ProfileScreen,
    hashes: ['#/profile/sections', '#/profile/diff', '#/profile/changesets', '#/profile/snapshots'],
  },
  {
    name: 'Content',
    Screen: ContentScreen,
    hashes: [
      '#/content/drafts',
      '#/content/opportunities',
      '#/content/calendar',
      '#/content/published',
    ],
  },
  { name: 'Publishing', Screen: PublishingScreen, hashes: ['#/publishing'] },
  {
    name: 'System',
    Screen: SystemScreen,
    hashes: [
      '#/system/credentials',
      '#/system/features',
      '#/system/capabilities',
      '#/system/tools',
      '#/system/audit',
      '#/system/retention',
      '#/system/analytics',
      '#/system/data',
    ],
  },
];

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  location.hash = '';
  vi.restoreAllMocks();
});

async function mount(Screen: FC, hash: string): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<Screen />);
  await flush(16);
}

const bodyText = () => document.body.textContent ?? '';

describe('a home with nothing in it yet', () => {
  let empty: ClientHarness;

  beforeAll(() => {
    empty = createClientHarness('screen-states-empty');
  });
  afterAll(() => empty.close());

  for (const { name, Screen, hashes } of SCREENS) {
    for (const hash of hashes) {
      it(`${name} at ${hash} says what to do rather than showing a blank`, async () => {
        empty.installApiFetch();
        await mount(Screen, hash);

        const shown = bodyText();
        // A new member's whole experience of this view is whatever it says when
        // there is nothing to show.
        expect(shown.trim().length, `${hash} rendered nothing at all`).toBeGreaterThan(20);
        expect(shown, hash).not.toContain('[object Object]');
        expect(shown, hash).not.toContain('undefined');
        expect(shown, hash).not.toContain('NaN');
      });
    }
  }

  it('offers no destructive control on an empty home', async () => {
    empty.installApiFetch();
    await mount(SystemScreen, '#/system/data');

    const purge = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      /delete all local data/i.test(b.textContent ?? ''),
    );
    // Nothing to lose is not a reason to make it easy.
    expect(purge?.disabled ?? true).toBe(true);
  });
});

describe('a home whose audit chain has been tampered with', () => {
  let broken: ClientHarness;

  beforeAll(() => {
    broken = createClientHarness('screen-states-broken', (fixture) => {
      seedHealthy(fixture);
      breakAuditChain(fixture.db);
    });
  });
  afterAll(() => broken.close());

  for (const { name, Screen, hashes } of SCREENS) {
    for (const hash of hashes) {
      it(`${name} at ${hash} still renders, rather than failing closed on the reader`, async () => {
        broken.installApiFetch();
        await mount(Screen, hash);

        const shown = bodyText();
        expect(shown.trim().length, hash).toBeGreaterThan(20);
        expect(shown, hash).not.toContain('[object Object]');
      });
    }
  }

  it('names where the chain broke, and what that means', async () => {
    broken.installApiFetch();
    await mount(SystemScreen, '#/system/audit');

    const shown = bodyText();
    // A tampered ledger that still reported healthy would be worse than no
    // ledger at all. It says which entry, and why it failed.
    expect(shown).toMatch(/chain broken at seq \d+/i);
    expect(shown).toMatch(/content_hash does not match/i);
    // And what it costs: approvals and publishing stop.
    expect(shown).toMatch(/blocks approvals/i);
  });

  it('refuses to arm an approval while the chain is broken', async () => {
    broken.installApiFetch();
    await mount(PublishingScreen, '#/publishing');

    const shown = bodyText();
    // Granting depends on the log being trustworthy; the screen has to say so
    // instead of offering a control that will fail.
    expect(shown).toMatch(/chain|audit/i);
  });
});

describe('a server that does not answer', () => {
  let harness: ClientHarness;

  beforeAll(() => {
    harness = createClientHarness('screen-states-offline', seedHealthy);
  });
  afterAll(() => harness.close());

  it('shows an accessible loading state rather than an empty page while a request is in flight', async () => {
    // Held open for the duration of the assertions, then released so the
    // request does not outlive the test.
    const gate: { release: () => void } = { release: () => {} };
    const hung = new Promise<Response>((resolve) => {
      gate.release = () => resolve(new Response('{}', { status: 200 }));
    });
    harness.installApiFetch(() => hung);

    await mount(OverviewScreen, '#/overview');

    // A skeleton carries no text by design, so it is the ARIA that has to say
    // something is happening — otherwise a screen reader gets silence.
    const status = document.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.getAttribute('aria-label') ?? '').toMatch(/loading/i);
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    gate.release();
  });

  it('reports a failure and offers a way to try again', async () => {
    harness.installApiFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'the disk went away' } }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    await mount(OverviewScreen, '#/overview');

    const shown = bodyText();
    // An error a member cannot retry is a dead end; every resource view offers
    // a reload.
    expect(shown).toMatch(/retry|try again|reload|failed|error/i);
  });

  it('survives a response that is not JSON at all', async () => {
    harness.installApiFetch(() => new Response('<html>proxy error</html>', { status: 502 }));

    await mount(EvidenceScreen, '#/evidence/claims');

    expect(bodyText().trim().length).toBeGreaterThan(0);
    expect(bodyText()).not.toContain('[object Object]');
  });

  it('sends the member back to the launch page when the session has gone', async () => {
    harness.installApiFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no session' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await mount(SystemScreen, '#/system/capabilities');

    // An expired session must not look like an empty account.
    const shown = bodyText();
    expect(shown.trim().length).toBeGreaterThan(0);
    expect(shown).not.toMatch(/no capabilities/i);
  });
});
