// @vitest-environment happy-dom
import axe from 'axe-core';
import { createRoot } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppShell } from '../../linkedin-dashboard/src/client/AppShell.tsx';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { SetupScreen } from '../../linkedin-dashboard/src/client/screens/Setup.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// Automated accessibility checks over every screen, in both themes, with real
// data behind them.
//
// One rule is disabled and it is worth being explicit about why: axe's
// colour-contrast rule needs computed layout, which happy-dom does not produce.
// Left enabled it reports nothing rather than reporting truthfully, which is
// worse than not running it. Contrast is covered instead by the pair matrix in
// tests/unit/design-tokens, which checks every (foreground, background)
// combination the design uses against its required ratio in both themes — and
// which caught five real failures in the proposed palette.
//
// Real zoom, real forced-colors and real rendering remain manual; see
// docs/dashboard-manual-checks.md.
const AXE_OPTIONS: axe.RunOptions = {
  rules: {
    'color-contrast': { enabled: false },
    // Landmark and region rules assume a whole document. Screens are mounted
    // in isolation here; AppShell is checked as a complete page below.
    region: { enabled: false },
  },
};

const SCREENS: Array<[string, FC]> = [
  ['Setup', SetupScreen],
  ['Overview', OverviewScreen],
  ['Evidence', EvidenceScreen],
  ['Profile', ProfileScreen],
  ['Content', ContentScreen],
  ['Publishing', PublishingScreen],
  ['System', SystemScreen],
];

let harness: ClientHarness;

beforeAll(() => {
  harness = createClientHarness('a11y', seedHealthy);
});

afterAll(() => harness.close());

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  harness.installApiFetch();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

function describeViolations(results: axe.AxeResults): string {
  return results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help}\n  ${violation.nodes
          .map((node) => node.html)
          .slice(0, 3)
          .join('\n  ')}`,
    )
    .join('\n');
}

describe('every screen passes axe with real data behind it', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const [name, Screen] of SCREENS) {
      it(`${name} in the ${theme} theme`, async () => {
        document.documentElement.dataset['theme'] = theme;
        createRoot(container).render(<Screen />);
        await flush(8);

        const results = await axe.run(container, AXE_OPTIONS);
        expect(describeViolations(results)).toBe('');
      });
    }
  }
});

describe('the whole page', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`has a complete landmark structure in the ${theme} theme`, async () => {
      document.documentElement.dataset['theme'] = theme;
      createRoot(container).render(<AppShell />);
      await flush(8);

      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(describeViolations(results)).toBe('');
    });
  }

  it('keeps the detail pane and the confirmation over it accessible together', async () => {
    // Two surfaces, one of each kind, open at once. Reviewing a claim opens a
    // docked region beside the list at this width — non-modal, so the list
    // stays operable — and confirming the decision opens a real modal over it.
    // Dialogs are where accessibility usually breaks: an unlabelled modal with
    // no accessible name is announced as nothing at all.
    document.documentElement.dataset['theme'] = 'dark';
    createRoot(container).render(<EvidenceScreen />);
    await flush(8);

    const review = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Review',
    );
    review?.click();
    await flush(8);

    // The detail is a named landmark, not an unlabelled div: a screen-reader
    // user navigating by landmark has to be able to find where the record went.
    // A <section> with an accessible name is a region without saying so.
    const detail = document.querySelector('section[aria-label="Review claim"]');
    expect(detail).not.toBeNull();

    const verify = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Verify',
    );
    verify?.click();
    await flush(8);

    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    const results = await axe.run(document.body, AXE_OPTIONS);
    expect(describeViolations(results)).toBe('');
  });
});
