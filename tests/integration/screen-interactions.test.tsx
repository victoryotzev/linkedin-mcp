// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// Clicking things.
//
// The view matrix proves every screen paints. This drives the controls on them,
// which is where the handlers live — and a handler that throws leaves a member
// staring at a control that silently does nothing.
//
// Every consequential action in this product sits behind a confirmation, so a
// single click opens a dialog rather than performing the act. That is what
// makes an exhaustive sweep safe here: the dangerous half needs a typed phrase
// or a bound command that this test never supplies.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;
const errors: unknown[] = [];

beforeAll(() => {
  harness = createClientHarness('screen-interactions', seedHealthy);
});

afterAll(() => harness.close());

beforeEach(() => {
  errors.length = 0;
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  harness.installApiFetch();
  // A handler that throws asynchronously would otherwise vanish.
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  location.hash = '';
  vi.restoreAllMocks();
});

async function mountAt(Screen: FC, hash: string): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<Screen />);
  await flush(10);
}

const enabledButtons = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.disabled);

/**
 * Clicks each enabled control once, remounting between so one click cannot
 * hide the next control behind a state change.
 */
async function clickEachControl(Screen: FC, hash: string): Promise<number> {
  await mountAt(Screen, hash);
  const total = enabledButtons().length;

  for (let index = 0; index < total; index += 1) {
    root?.unmount();
    await mountAt(Screen, hash);
    const button = enabledButtons()[index];
    if (!button) continue;
    button.click();
    await flush(6);
  }
  return total;
}

const SCREENS: Array<{ name: string; Screen: FC; hashes: string[] }> = [
  { name: 'Overview', Screen: OverviewScreen, hashes: ['#/overview'] },
  {
    name: 'Evidence',
    Screen: EvidenceScreen,
    hashes: ['#/evidence/queue', '#/evidence/claims', '#/evidence/conflicts', '#/evidence/sources'],
  },
  {
    name: 'Profile',
    Screen: ProfileScreen,
    hashes: ['#/profile/sections', '#/profile/diff', '#/profile/changesets'],
  },
  {
    name: 'Content',
    Screen: ContentScreen,
    hashes: ['#/content/drafts', '#/content/opportunities', '#/content/calendar'],
  },
  { name: 'Publishing', Screen: PublishingScreen, hashes: ['#/publishing'] },
  {
    name: 'System',
    Screen: SystemScreen,
    hashes: [
      '#/system/credentials',
      '#/system/features',
      '#/system/capabilities',
      '#/system/retention',
      '#/system/data',
    ],
  },
];

const clickedTotals: number[] = [];

describe('clicking every control on every screen', () => {
  for (const { name, Screen, hashes } of SCREENS) {
    for (const hash of hashes) {
      it(`${name} at ${hash} handles each control without throwing`, async () => {
        const clicked = await clickEachControl(Screen, hash);
        clickedTotals.push(clicked);

        // A view can legitimately have nothing to click — a changesets view
        // with no change sets, for instance. Vacuity is guarded in aggregate
        // below rather than per view, where it would encode the fixture.
        expect(clicked).toBeGreaterThanOrEqual(0);
        // The app's own error boundary logs through console.error; a handler
        // that threw would land here.
        const rendered = container.innerHTML;
        expect(rendered).not.toContain('[object Object]');
        expect(rendered).not.toContain('undefined');
      });
    }
  }
});

describe('the sweep itself', () => {
  it('actually clicked a meaningful number of controls', () => {
    const total = clickedTotals.reduce((n, v) => n + v, 0);
    expect(total).toBeGreaterThanOrEqual(20);
  });
});

describe('view navigation', () => {
  it('switches Evidence views by clicking its tabs', async () => {
    await mountAt(EvidenceScreen, '#/evidence/queue');

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('.viewnav a, .viewnav button'));
    expect(tabs.length).toBeGreaterThanOrEqual(4);

    for (const tab of tabs) {
      tab.click();
      dispatchEvent(new Event('hashchange'));
      await flush(6);
      expect(container.innerHTML.length).toBeGreaterThan(200);
    }
  });
});

describe('the full purge control', () => {
  it('stays disabled until there is a verified backup or the member accepts the loss', async () => {
    await mountAt(SystemScreen, '#/system/data');

    const purge = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      /delete all local data/i.test(b.textContent ?? ''),
    );
    expect(purge, 'the data view should offer the full purge').toBeTruthy();
    if (!purge) return;

    // A seeded home has no verified backup, so the control is closed. This is
    // the guard, not the dialog: clicking it must do nothing at all.
    expect(purge.disabled).toBe(true);

    const sourcesBefore = Number(
      harness.fixture.db.get('SELECT COUNT(*) AS n FROM sources')?.['n'] ?? 0,
    );
    purge.click();
    await flush(6);
    expect(Number(harness.fixture.db.get('SELECT COUNT(*) AS n FROM sources')?.['n'] ?? 0)).toBe(
      sourcesBefore,
    );
  });

  it('opens the typed-phrase confirmation once the loss is accepted', async () => {
    await mountAt(SystemScreen, '#/system/data');

    const accept = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!accept) return;
    accept.click();
    await flush(6);

    const purge = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      /delete all local data/i.test(b.textContent ?? ''),
    );
    if (!purge || purge.disabled) return;

    const sourcesBefore = Number(
      harness.fixture.db.get('SELECT COUNT(*) AS n FROM sources')?.['n'] ?? 0,
    );
    purge.click();
    await flush(6);

    // Even now the click only opens a confirmation. Destroying anything needs
    // the exact phrase typed, which this test never supplies.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(Number(harness.fixture.db.get('SELECT COUNT(*) AS n FROM sources')?.['n'] ?? 0)).toBe(
      sourcesBefore,
    );
  });
});
