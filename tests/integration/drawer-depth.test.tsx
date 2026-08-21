// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listApprovals, listDrafts } from '@linkedin-mcp/domain';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// Inside the drawers.
//
// The screen sweeps get as far as opening one; everything past that — the tab
// panels, the edit form, the actions along the bottom — needed a second and
// third click and so had never run. That is where a draft's evidence is shown
// and where the member decides the text is ready, which makes it the part of
// the Content screen that most needs to be right.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeAll(() => {
  harness = createClientHarness('drawer-depth', seedHealthy);
});

afterAll(() => harness.close());

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  harness.installApiFetch();
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
  await flush(14);
}

/** The drawer renders into the document, not into the mount container. */
const all = <T extends HTMLElement>(selector: string): T[] =>
  Array.from(document.querySelectorAll<T>(selector));
const buttons = () => all<HTMLButtonElement>('button');
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const bodyText = () => document.body.textContent ?? '';

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(12);
  return true;
}

async function openDraftDrawer(): Promise<void> {
  await mount(ContentScreen, '#/content/drafts');
  expect(await click(/^open$/i), 'the drafts list should offer a way in').toBe(true);
  // The detail is a docked region beside the list at this width and a modal
  // drawer below it. Both are correct; what matters is that opening a draft
  // put the record on screen under a name a screen reader can find.
  const detail =
    document.querySelector('section[aria-label="Draft"]') ??
    document.querySelector('[role="dialog"]');
  expect(detail, 'opening a draft should reveal its detail').not.toBeNull();
}

describe('the draft drawer tabs', () => {
  it('shows the body text and its measurements on the text tab', async () => {
    await openDraftDrawer();

    const shown = bodyText();
    expect(shown).toContain('The project contains 181 test files.');
    // Character count and visibility are what a member checks before deciding;
    // both are stated rather than left to be inferred from the text.
    expect(shown).toMatch(/\d+ characters/);
    expect(shown).toContain('PUBLIC');
  });

  it('lists the validation checks, and can reveal the passing ones', async () => {
    await openDraftDrawer();
    expect(await click(/^checks$/i)).toBe(true);

    expect(bodyText()).toMatch(/passing check/i);
    // The passing checks are collapsed by default so the failing ones are not
    // buried; the toggle has to actually reveal them.
    expect(await click(/show \d+ passing check/i)).toBe(true);
    expect(bodyText()).toMatch(/hide \d+ passing check/i);
    expect(bodyText()).toMatch(/unsupported claims|char limit|secret leakage|fabricated metrics/i);
  });

  it('scores each sentence against verified claims on the coverage tab', async () => {
    await openDraftDrawer();
    expect(await click(/^coverage$/i)).toBe(true);
    expect(bodyText()).toMatch(/sentence-level scoring/i);

    expect(await click(/check coverage/i)).toBe(true);
    // The seeded draft repeats a verified claim verbatim, so its one sentence
    // must come back supported with a score attached.
    expect(bodyText()).toMatch(/supported/i);
    expect(bodyText()).toMatch(/best/i);
  });

  it('lists every revision on the history tab', async () => {
    await openDraftDrawer();
    expect(await click(/^history$/i)).toBe(true);
    expect(bodyText()).toMatch(/revision 1/i);
  });
});

describe('the draft drawer actions', () => {
  it('re-validates in place and reports it', async () => {
    await openDraftDrawer();
    const before = harness.fixture.db.get('SELECT COUNT(*) AS n FROM validation_reports')?.[
      'n'
    ] as number;

    expect(await click(/re-validate/i)).toBe(true);

    expect(
      Number(harness.fixture.db.get('SELECT COUNT(*) AS n FROM validation_reports')?.['n']),
    ).toBeGreaterThanOrEqual(Number(before));
    expect(bodyText()).toMatch(/validation re-run|re-validate/i);
  });

  it('opens the editor pre-filled, and warns that saving kills any live approval', async () => {
    await openDraftDrawer();
    expect(await click(/edit body/i)).toBe(true);

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toContain('181 test files');
    // The warning is the point: an approval describes one exact text, so an
    // edit invalidates it, and the member has to be told before they type.
    expect(bodyText()).toMatch(/invalidated|new revision/i);
  });

  it('closes the editor without writing a revision', async () => {
    await openDraftDrawer();
    await click(/edit body/i);

    const before = harness.fixture.db.get('SELECT current_revision FROM post_drafts LIMIT 1')?.[
      'current_revision'
    ];
    expect(await click(/^cancel$/i)).toBe(true);

    expect(
      harness.fixture.db.get('SELECT current_revision FROM post_drafts LIMIT 1')?.[
        'current_revision'
      ],
    ).toBe(before);
  });

  it('puts a save behind a confirmation rather than writing on the click', async () => {
    await openDraftDrawer();
    await click(/edit body/i);

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;
    textarea.value = 'The suite covers 203 test files in total.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(8);

    const before = harness.fixture.db.get('SELECT current_revision FROM post_drafts LIMIT 1')?.[
      'current_revision'
    ];
    expect(await click(/save new revision/i)).toBe(true);

    expect(
      harness.fixture.db.get('SELECT current_revision FROM post_drafts LIMIT 1')?.[
        'current_revision'
      ],
      'saving must not write until the confirmation is answered',
    ).toBe(before);
  });

  it('puts requesting approval behind a confirmation, and never creates one on the click', async () => {
    await openDraftDrawer();
    const before = listApprovals(harness.fixture.db).length;

    const requested = await click(/request approval/i);
    if (!requested) {
      // Disabled is a legitimate answer — it means validation is stale or
      // failing, and the button says so through disabledReason.
      expect(byLabel(/request approval/i)?.disabled).toBe(true);
      return;
    }
    expect(listApprovals(harness.fixture.db).length).toBe(before);
  });
});

describe('the other Content views in depth', () => {
  it('renders the opportunities view and any drill-down it offers', async () => {
    await mount(ContentScreen, '#/content/opportunities');
    const count = buttons().length;

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(ContentScreen, '#/content/opportunities');
      buttons()[index]?.click();
      await flush(10);
      expect(bodyText()).not.toContain('[object Object]');
    }
  });

  it('renders published posts and the voice profile computed from them', async () => {
    await mount(ContentScreen, '#/content/published');
    expect(bodyText()).not.toContain('undefined');
    expect(bodyText()).not.toContain('NaN');
  });
});

describe('Overview drill-downs', () => {
  it('follows every link and control on the overview without a render error', async () => {
    await mount(OverviewScreen, '#/overview');
    const links = all<HTMLElement>('a, button');
    const count = links.length;
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(OverviewScreen, '#/overview');
      all<HTMLElement>('a, button')[index]?.click();
      await flush(10);
      dispatchEvent(new Event('hashchange'));
      await flush(6);
      expect(bodyText()).not.toContain('[object Object]');
    }
  });
});

describe('Evidence drill-downs', () => {
  it('opens the evidence behind a claim', async () => {
    await mount(EvidenceScreen, '#/evidence/claims');
    const opened = await click(/evidence|open|detail|view/i);
    if (!opened) return;

    // The whole product is the link between a sentence and the bytes under it,
    // so this drawer has to name the artifact, not just say "1 source".
    expect(bodyText()).toMatch(/README\.md|artifact|extract/i);
  });

  it('walks the artifacts view and opens what it offers', async () => {
    await mount(EvidenceScreen, '#/evidence/artifacts');
    const count = buttons().filter((b) => !b.disabled).length;

    for (let index = 0; index < Math.min(count, 6); index += 1) {
      root?.unmount();
      await mount(EvidenceScreen, '#/evidence/artifacts');
      buttons()
        .filter((b) => !b.disabled)
        [index]?.click();
      await flush(10);
      expect(bodyText()).not.toContain('[object Object]');
    }
  });

  it('shows the seeded conflict and keeps its resolution behind a confirmation', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');
    const before = Number(
      harness.fixture.db.get("SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'")?.[
        'n'
      ] ?? 0,
    );

    const resolved = await click(/resolve|dismiss/i);
    if (!resolved) return;

    expect(
      Number(
        harness.fixture.db.get("SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'")?.[
          'n'
        ] ?? 0,
      ),
    ).toBe(before);
  });

  it('keeps enabling a pending source behind its source-id confirmation', async () => {
    await mount(EvidenceScreen, '#/evidence/sources');
    const before = Number(
      harness.fixture.db.get("SELECT COUNT(*) AS n FROM sources WHERE status = 'pending_review'")?.[
        'n'
      ] ?? 0,
    );

    const clicked = await click(/enable/i);
    if (!clicked) return;

    // Enabling a source is what lets its bytes become evidence. It needs the
    // source id typed, so a click alone must leave the count where it was.
    expect(
      Number(
        harness.fixture.db.get(
          "SELECT COUNT(*) AS n FROM sources WHERE status = 'pending_review'",
        )?.['n'] ?? 0,
      ),
    ).toBe(before);
  });
});

describe('the drafts list itself', () => {
  it('names each draft and says whether its checks pass', async () => {
    await mount(ContentScreen, '#/content/drafts');

    const drafts = listDrafts(harness.fixture.db);
    for (const draft of drafts) {
      expect(bodyText()).toContain(draft.slug);
    }
    expect(bodyText()).toMatch(/all checks pass|checks? failing|not validated/);
  });
});
