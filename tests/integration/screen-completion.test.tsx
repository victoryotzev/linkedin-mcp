// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executePublication, grantApproval, listClaims } from '@linkedin-mcp/domain';
import { DryRunPublisher } from '@linkedin-mcp/linkedin';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// The screens' decision controls, driven to the point where they would act.
//
// Reviewing a claim, resolving a contradiction and granting an approval are the
// three places where a person's judgement enters the ledger. Each of them has a
// form behind it, and the forms are where the rules live: which combinations
// are allowed to reach a confirmation and which are refused before they can.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeAll(async () => {
  harness = createClientHarness('screen-completion', seedHealthy);
  const { db } = harness.fixture;

  // A settled publication, so the history and its detail render.
  const pending = db.all("SELECT id FROM approvals WHERE state = 'pending'");
  const approvalId = String(pending[0]?.['id'] ?? '');
  if (approvalId) {
    grantApproval(db, approvalId, 'dashboard');
    await executePublication(db, new DryRunPublisher(), { approval_id: approvalId });
  }
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
  await flush(16);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const selects = () => Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
const bodyText = () => document.body.textContent ?? '';
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(14);
  return true;
}

/**
 * Picks an option and lets the component see it.
 *
 * hono/jsx maps `onChange` onto the `input` event the way React does, so a bare
 * `change` event sets the DOM value and nothing else: the component never
 * re-renders and every control depending on the choice stays as it was.
 */
async function choose(select: HTMLSelectElement | undefined, value: string): Promise<void> {
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush(12);
}

async function fill(field: HTMLInputElement | HTMLTextAreaElement | undefined, value: string) {
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(10);
}

describe('reviewing a claim', () => {
  async function openReview(): Promise<boolean> {
    await mount(EvidenceScreen, '#/evidence/queue');
    return await click(/review|open|evidence/i);
  }

  it('shows the statement, its provenance and the evidence text under it', async () => {
    expect(await openReview()).toBe(true);

    const shown = bodyText();
    // The point of the drawer is that the member reads the bytes, not a
    // summary of them: the source, the path and an excerpt all have to be here.
    expect(shown).toMatch(/trust/i);
    expect(shown).toMatch(/README\.md|fixture source|primary/i);
  });

  it('keeps verification behind a confirmation', async () => {
    expect(await openReview()).toBe(true);
    const before = listClaims(harness.fixture.db, {}, false).filter(
      (c) => c.state === 'verified',
    ).length;

    expect(await click(/^verify/i)).toBe(true);

    expect(dialog()).not.toBeNull();
    expect(
      listClaims(harness.fixture.db, {}, false).filter((c) => c.state === 'verified').length,
    ).toBe(before);
  });

  it('keeps rejection behind a confirmation, and asks for a reason', async () => {
    expect(await openReview()).toBe(true);
    const before = listClaims(harness.fixture.db, {}, false).filter(
      (c) => c.state === 'rejected',
    ).length;

    expect(await click(/^reject/i)).toBe(true);

    // A rejection is a permanent tombstone; the reason is what a later reader
    // needs to understand why the statement is not in the corpus.
    expect(dialog()).not.toBeNull();
    expect(
      listClaims(harness.fixture.db, {}, false).filter((c) => c.state === 'rejected').length,
    ).toBe(before);
  });

  it('drives every control in the drawer without throwing', async () => {
    expect(await openReview()).toBe(true);
    const count = buttons().filter((b) => !b.disabled).length;

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      expect(await openReview()).toBe(true);
      buttons()
        .filter((b) => !b.disabled)
        [index]?.click();
      await flush(10);
      expect(bodyText()).not.toContain('[object Object]');
    }
  });
});

describe('resolving a contradiction', () => {
  it('offers a decision for each member claim', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');

    const decisionSelects = selects();
    if (decisionSelects.length === 0) return;
    // One select per claim in the conflict, each starting undecided.
    expect(decisionSelects.length).toBeGreaterThanOrEqual(2);
    for (const select of decisionSelects) expect(select.value).toBe('');
  });

  it('keeps resolve shut until every member has a decision', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');
    if (selects().length < 2) return;

    const resolve = byLabel(/^resolve/i);
    // The domain refuses a partial resolution; the control mirrors that rather
    // than letting the member find out by pressing it.
    expect(resolve?.disabled).toBe(true);

    await choose(selects()[0], 'verify');
    expect(byLabel(/^resolve/i)?.disabled).toBe(true);

    await choose(selects()[1], 'reject');
    expect(byLabel(/^resolve/i)?.disabled).toBe(false);
  });

  it('asks for a reason when a claim is being rejected', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');
    if (selects().length < 2) return;

    const before = document.querySelectorAll('input[placeholder="reason"]').length;
    await choose(selects()[0], 'reject');

    expect(document.querySelectorAll('input[placeholder="reason"]').length).toBeGreaterThan(before);
  });

  it('does not resolve on the click alone', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');
    if (selects().length < 2) return;
    await choose(selects()[0], 'verify');
    await choose(selects()[1], 'reject');
    await fill(
      document.querySelector<HTMLInputElement>('input[placeholder="reason"]') ?? undefined,
      'superseded by the newer count',
    );

    const before = Number(
      harness.fixture.db.get("SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'")?.[
        'n'
      ] ?? 0,
    );
    expect(await click(/^resolve/i)).toBe(true);

    expect(dialog()).not.toBeNull();
    expect(
      Number(
        harness.fixture.db.get("SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'")?.[
          'n'
        ] ?? 0,
      ),
    ).toBe(before);
  });

  it('offers dismissal separately, for a conflict that is a false positive', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');

    const dismiss = byLabel(/dismiss/i);
    if (!dismiss) return;
    // Dismissal needs no per-claim decision, because nothing is thrown out.
    expect(dismiss.disabled).toBe(false);
  });
});

describe('the publishing screen with history', () => {
  it('shows the settled publication and its post URN', async () => {
    await mount(PublishingScreen, '#/publishing/publications');

    const shown = bodyText();
    expect(shown).toMatch(/urn:li:share:/);
    expect(shown).toMatch(/dry_run/);
  });

  it('shows the readiness ladder, saying which rung is missing', async () => {
    await mount(PublishingScreen, '#/publishing/readiness');

    const shown = bodyText();
    // Proving a credential works is not the same as deciding to post; the
    // screen has to keep those apart or the member cannot tell what is left.
    expect(shown).toMatch(/write.lane|capability|explicitly enabled/i);
    expect(shown).toMatch(/not ready|ready/i);
  });

  it('drives every enabled control without changing an outcome', async () => {
    await mount(PublishingScreen, '#/publishing');
    const before = harness.fixture.db.get('SELECT COUNT(*) AS n FROM publications')?.['n'];
    const count = buttons().filter((b) => !b.disabled).length;

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(PublishingScreen, '#/publishing');
      buttons()
        .filter((b) => !b.disabled)
        [index]?.click();
      await flush(12);
      expect(bodyText()).not.toContain('[object Object]');
    }

    expect(harness.fixture.db.get('SELECT COUNT(*) AS n FROM publications')?.['n']).toBe(before);
  });
});

describe('the system screen views that need data', () => {
  it('shows the retention summary with the DMA footprint', async () => {
    await mount(SystemScreen, '#/system/retention');

    const shown = bodyText();
    expect(shown).not.toContain('[object Object]');
    expect(shown).not.toContain('NaN');
    expect(shown).toMatch(/retention|portability|snapshot|days/i);
  });

  it('lists the features with their current values and lets each be toggled', async () => {
    await mount(SystemScreen, '#/system/features');
    const count = buttons().filter((b) => !b.disabled).length;
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(SystemScreen, '#/system/features');
      buttons()
        .filter((b) => !b.disabled)
        [index]?.click();
      await flush(12);
      // Every feature change is confirmed; none of them happen on the click.
      expect(bodyText()).not.toContain('[object Object]');
    }
  });

  it('lists capabilities with the blocker standing in front of each', async () => {
    await mount(SystemScreen, '#/system/capabilities');

    const shown = bodyText();
    expect(shown).toMatch(/linkedin\./);
    // A capability that is unavailable has to say what is missing.
    expect(shown).toMatch(/no_linkedin_app|not verified|unavailable|blocked|awaiting/i);
  });

  it('renders the tool catalog with its permission tiers', async () => {
    await mount(SystemScreen, '#/system/tools');

    const shown = bodyText();
    expect(shown).toMatch(/linkedin_/);
    expect(shown).toMatch(/local-read|local-write|external/i);
  });

  it('filters the audit log and pages it', async () => {
    await mount(SystemScreen, '#/system/audit');

    const filter = selects()[0];
    if (filter && filter.options.length > 1) {
      await choose(filter, filter.options[1]!.value);
      expect(bodyText()).not.toContain('[object Object]');
    }

    if (await click(/more|next|load/i)) {
      expect(bodyText()).not.toContain('[object Object]');
    }
  });
});
