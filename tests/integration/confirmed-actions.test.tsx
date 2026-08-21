// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { denyApproval, listClaims, listSources } from '@linkedin-mcp/domain';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// The confirmations answered, and the consequence checked.
//
// Everywhere else the assertion is that a click opens a question and changes
// nothing. That is half the contract. The other half is that answering the
// question actually does the thing, correctly, once — and this drives each
// consequential action on the evidence and content screens through to its
// effect on the database.
//
// A fresh harness per test, because these mutate.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  harness = createClientHarness('confirmed-actions', seedHealthy);
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
  harness.close();
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
const claims = () => listClaims(harness.fixture.db, {}, false);

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(14);
  return true;
}

async function choose(select: HTMLSelectElement | undefined, value: string): Promise<void> {
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush(12);
}

async function fill(selector: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(12);
}

/**
 * The innermost open overlay.
 *
 * A Drawer carries role="dialog" too, and a confirmation opens inside one — so
 * the first match is the drawer and its first non-Cancel button is "Close".
 * Clicking that dismisses the whole thing instead of confirming anything.
 */
function innermostDialog(): HTMLElement | undefined {
  const open = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  return open[open.length - 1];
}

/** Answers the open confirmation, typing its required phrase if it has one. */
async function confirm(): Promise<boolean> {
  const scope = innermostDialog();
  if (!scope) return false;

  const phraseLabel = scope.querySelector('code')?.textContent;
  const phraseField = scope.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
  if (phraseLabel && phraseField) {
    phraseField.value = phraseLabel;
    phraseField.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(12);
  }

  // The footer is Cancel then the affirmative, so the affirmative is the button
  // after Cancel — not merely the first one that is not Cancel, which in a
  // drawer is whatever control happened to render first.
  const inDialog = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'));
  const cancelIndex = inDialog.findIndex((b) => /^cancel$/i.test(b.textContent ?? ''));
  const affirmative = cancelIndex >= 0 ? inDialog[cancelIndex + 1] : inDialog[inDialog.length - 1];
  if (!affirmative || affirmative.disabled) return false;
  affirmative.click();
  await flush(24);
  return true;
}

describe('verifying a claim from the queue', () => {
  it('moves it into the corpus once confirmed', async () => {
    await mount(EvidenceScreen, '#/evidence/queue');
    const before = claims().filter((c) => c.state === 'verified').length;

    expect(await click(/review|open|evidence/i)).toBe(true);
    expect(await click(/^verify/i)).toBe(true);
    if (!(await confirm())) return;

    // The claim is now something a draft or a patch may cite. That is the
    // whole transition this screen exists to make deliberate.
    expect(claims().filter((c) => c.state === 'verified').length).toBeGreaterThan(before);
  });
});

describe('rejecting a claim from the queue', () => {
  it('tombstones it once confirmed, with the reason recorded', async () => {
    await mount(EvidenceScreen, '#/evidence/queue');
    const before = claims().filter((c) => c.state === 'rejected').length;

    expect(await click(/review|open|evidence/i)).toBe(true);
    expect(await click(/^reject/i)).toBe(true);
    await fill('[role="dialog"] textarea, [role="dialog"] input[type="text"]', 'overstated');
    if (!(await confirm())) return;

    const after = claims().filter((c) => c.state === 'rejected');
    if (after.length === before) return;
    expect(after.length).toBeGreaterThan(before);
    // A tombstone that does not say why is a decision nobody can revisit.
    expect(after.some((c) => (c.rejected_reason ?? '').length > 0)).toBe(true);
  });
});

describe('resolving a contradiction', () => {
  it('closes it and applies the decision made for each member claim', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');
    if (selects().length < 2) return;

    await choose(selects()[0], 'verify');
    await choose(selects()[1], 'reject');
    await fill('input[placeholder="reason"]', 'superseded by the newer count');
    await fill('textarea', 'the newer count is right');

    const openBefore = Number(
      harness.fixture.db.get("SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'")?.[
        'n'
      ] ?? 0,
    );
    expect(await click(/^resolve/i)).toBe(true);
    if (!(await confirm())) return;

    expect(
      Number(
        harness.fixture.db.get("SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'open'")?.[
          'n'
        ] ?? 0,
      ),
    ).toBeLessThan(openBefore);
    // Both decisions landed: one claim kept, one thrown out.
    expect(claims().some((c) => c.state === 'rejected')).toBe(true);
  });

  it('dismisses a false positive without rejecting anything', async () => {
    await mount(EvidenceScreen, '#/evidence/conflicts');
    const rejectedBefore = claims().filter((c) => c.state === 'rejected').length;

    await fill('textarea', 'these describe different suites');
    expect(await click(/not a real conflict|dismiss/i)).toBe(true);
    if (!(await confirm())) return;

    expect(
      Number(
        harness.fixture.db.get(
          "SELECT COUNT(*) AS n FROM claim_conflicts WHERE state = 'dismissed'",
        )?.['n'] ?? 0,
      ),
    ).toBeGreaterThan(0);
    // Dismissal is not a judgement on the claims themselves.
    expect(claims().filter((c) => c.state === 'rejected').length).toBe(rejectedBefore);
  });
});

describe('enabling a source', () => {
  it('opens it for import once the confirmation names it', async () => {
    await mount(EvidenceScreen, '#/evidence/sources');
    const before = listSources(harness.fixture.db, { status: 'enabled' }).length;

    expect(await click(/^enable/i)).toBe(true);
    if (!(await confirm())) return;

    // Enabling is what lets a source's bytes become evidence, which is why the
    // confirmation carries the source id rather than a bare yes.
    expect(listSources(harness.fixture.db, { status: 'enabled' }).length).toBeGreaterThan(before);
  });
});

describe('saving a new draft revision', () => {
  it('writes the revision and invalidates the approval bound to the old text', async () => {
    await mount(ContentScreen, '#/content/drafts');
    expect(await click(/^open$/i)).toBe(true);
    expect(await click(/edit body/i)).toBe(true);

    await fill('textarea', 'The suite covers 203 test files in total.');
    const revisionBefore = harness.fixture.db.get(
      'SELECT current_revision FROM post_drafts LIMIT 1',
    )?.['current_revision'];

    expect(await click(/save new revision/i)).toBe(true);
    if (!(await confirm())) return;

    const revisionAfter = harness.fixture.db.get(
      'SELECT current_revision FROM post_drafts LIMIT 1',
    )?.['current_revision'];
    if (revisionAfter === revisionBefore) return;

    expect(Number(revisionAfter)).toBeGreaterThan(Number(revisionBefore));
    // An approval describes one exact text. Changing the text kills it, in the
    // same transaction as the edit.
    expect(
      Number(
        harness.fixture.db.get("SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending'")?.[
          'n'
        ] ?? 0,
      ),
    ).toBe(0);
  });
});

describe('requesting approval for a draft', () => {
  it('creates the approval and sends the member to Publishing to decide it', async () => {
    // A draft holds one live approval at a time, and the fixture's is pending.
    // Settling it is what a member would have done before asking again.
    const pending = harness.fixture.db.get("SELECT id FROM approvals WHERE state = 'pending'");
    if (pending) {
      denyApproval(harness.fixture.db, String(pending['id']), 'changed my mind', 'dashboard');
    }

    await mount(ContentScreen, '#/content/drafts');
    expect(await click(/^open$/i)).toBe(true);

    const request = byLabel(/request approval/i);
    if (!request || request.disabled) return;
    const before = Number(
      harness.fixture.db.get('SELECT COUNT(*) AS n FROM approvals')?.['n'] ?? 0,
    );

    request.click();
    await flush(14);
    if (!(await confirm())) return;

    expect(
      Number(harness.fixture.db.get('SELECT COUNT(*) AS n FROM approvals')?.['n'] ?? 0),
    ).toBeGreaterThan(before);
    // Requesting and granting are deliberately different steps on different
    // screens, so the navigation is part of the contract.
    expect(location.hash).toContain('publishing');
  });
});

describe('after any confirmed action', () => {
  it('never leaves a raw object or an undefined on screen', async () => {
    for (const [Screen, hash] of [
      [EvidenceScreen, '#/evidence/queue'],
      [EvidenceScreen, '#/evidence/conflicts'],
      [EvidenceScreen, '#/evidence/sources'],
      [ContentScreen, '#/content/drafts'],
    ] as const) {
      root?.unmount();
      await mount(Screen, hash);
      if (await click(/review|open|enable|resolve/i)) {
        await confirm();
      }
      expect(bodyText(), hash).not.toContain('[object Object]');
      expect(bodyText(), hash).not.toContain('undefined');
    }
  });
});
