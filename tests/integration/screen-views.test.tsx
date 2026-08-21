// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SetupScreen } from '../../linkedin-dashboard/src/client/screens/Setup.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// Every screen, in every sub-view, rendered against the real API over a seeded
// database.
//
// The suites that came before this mount a screen or two and drive specific
// interactions. What was missing is breadth: a sub-view nobody opened could
// throw on first paint and no test would notice, because the route that
// selects it is a hash the tests never set.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeAll(() => {
  harness = createClientHarness('screen-views', seedHealthy);
});

afterAll(() => harness.close());

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  harness.installApiFetch();
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  location.hash = '';
});

/** Mounts a screen at a given route and waits for its data to arrive. */
async function mountAt(Screen: FC, hash: string): Promise<string> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<Screen />);
  await flush(10);
  return container.innerHTML;
}

const SCREENS: Array<{ name: string; Screen: FC; destination: string; views: string[] }> = [
  { name: 'Overview', Screen: OverviewScreen, destination: 'overview', views: [''] },
  {
    name: 'Evidence',
    Screen: EvidenceScreen,
    destination: 'evidence',
    views: ['', 'queue', 'claims', 'conflicts', 'sources', 'artifacts'],
  },
  {
    name: 'Profile',
    Screen: ProfileScreen,
    destination: 'profile',
    views: ['', 'sections', 'diff', 'changesets', 'snapshots'],
  },
  {
    name: 'Content',
    Screen: ContentScreen,
    destination: 'content',
    views: ['', 'drafts', 'opportunities', 'calendar', 'published'],
  },
  { name: 'Publishing', Screen: PublishingScreen, destination: 'publishing', views: [''] },
  {
    name: 'System',
    Screen: SystemScreen,
    destination: 'system',
    views: [
      '',
      'credentials',
      'features',
      'capabilities',
      'tools',
      'audit',
      'retention',
      'analytics',
      'data',
    ],
  },
  { name: 'Setup', Screen: SetupScreen, destination: 'setup', views: [''] },
];

describe('every screen, in every sub-view', () => {
  for (const { name, Screen, destination, views } of SCREENS) {
    for (const view of views) {
      const hash = view === '' ? `#/${destination}` : `#/${destination}/${view}`;

      it(`${name} renders at ${hash}`, async () => {
        const html = await mountAt(Screen, hash);

        // Rendered something real, not an empty shell.
        expect(html.length).toBeGreaterThan(200);
        // A failed resource shows InlineError; a thrown render shows nothing.
        // Neither is acceptable on a healthy seeded ledger.
        expect(html).not.toContain('internal error');
        expect(html).not.toContain('undefined');
        expect(html).not.toContain('[object Object]');
        expect(html).not.toContain('NaN');
      });
    }
  }
});

describe('screens that must not silently render empty', () => {
  it('Overview shows the work queue drawn from seeded state', async () => {
    const html = await mountAt(OverviewScreen, '#/overview');
    expect(html).toMatch(/queue|decision|blocked|review/i);
  });

  it('Evidence lists the seeded claims', async () => {
    const html = await mountAt(EvidenceScreen, '#/evidence/claims');
    expect(html).toContain('181 test files');
  });

  it('Evidence surfaces the seeded conflict', async () => {
    const html = await mountAt(EvidenceScreen, '#/evidence/conflicts');
    expect(html).toMatch(/conflict/i);
  });

  it('System lists the exact MCP tool registry', async () => {
    const html = await mountAt(SystemScreen, '#/system/tools');
    // The console is the same registry the MCP server exposes, so a tool name
    // must actually appear rather than a placeholder.
    expect(html).toContain('linkedin_');
  });

  it('System shows the audit chain', async () => {
    const html = await mountAt(SystemScreen, '#/system/audit');
    expect(html).toMatch(/audit|chain|event/i);
  });

  it('Setup reports readiness checks', async () => {
    const html = await mountAt(SetupScreen, '#/setup');
    expect(html).toMatch(/Application data home|Database schema|Evidence/);
  });
});

describe('an unknown sub-view', () => {
  it('falls back rather than rendering nothing', async () => {
    // A bookmarked or mistyped view must not produce a blank screen.
    const html = await mountAt(SystemScreen, '#/system/not-a-real-view');
    expect(html.length).toBeGreaterThan(200);
  });
});
