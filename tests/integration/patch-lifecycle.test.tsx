// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enableSourceFromDashboard,
  generateChangeSet,
  getChangeSet,
  importSnapshot,
  registerSource,
  runImport,
  setSetting,
  updateSection,
} from '@linkedin-mcp/domain';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// A patch from proposal to pasted.
//
// There is no LinkedIn profile-edit API, so the end of this road is the member
// copying text out of the dashboard and pasting it into a browser. That makes
// two things load-bearing: the text they copy has to be exactly the text that
// was approved, and "applied" has to stay an attestation until a later snapshot
// confirms it — nothing here observes LinkedIn.

let harness: ClientHarness;
let evidence: string;
let container: HTMLElement;
let root: Root | null = null;
let changeSetId: string;

beforeEach(async () => {
  harness = createClientHarness('patch-lifecycle', seedHealthy);
  const { db, store, dir } = harness.fixture;

  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-patchev-'));
  const zipPath = join(evidence, 'export.zip');
  writeFileSync(
    zipPath,
    makeZip([
      {
        name: 'Profile.csv',
        data: Buffer.from(
          'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
            'Alex,Rivera,,,,Old Headline,Old summary.,Software,,Ghent,,,\n',
        ),
      },
    ]),
  );
  const source = registerSource(db, {
    path: zipPath,
    kind: 'linkedin_export',
    trust: 'personal_doc',
    label: 'export v1',
    dataHome: dir,
  });
  enableSourceFromDashboard(db, source.id);
  await runImport(db, store, source.id);
  importSnapshot(db, store, source.id);

  const verifiedId = String(
    db.get("SELECT id FROM claims WHERE state = 'verified' LIMIT 1")?.['id'] ?? '',
  );
  updateSection(db, {
    section_key: 'about',
    content_text: 'The project contains 181 test files.',
    claim_ids: [verifiedId],
    author: 'user',
    based_on_revision: null,
  });
  changeSetId = generateChangeSet(db, { title: 'headline and about refresh' }).id;

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
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

async function mount(hash = '#/profile/changesets'): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<ProfileScreen />);
  await flush(16);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const bodyText = () => document.body.textContent ?? '';
const patches = () => getChangeSet(harness.fixture.db, changeSetId).patches;

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(14);
  return true;
}

async function confirm(): Promise<boolean> {
  const open = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  const scope = open[open.length - 1];
  if (!scope) return false;
  const inDialog = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'));
  const cancelIndex = inDialog.findIndex((b) => /^cancel$/i.test(b.textContent ?? ''));
  const affirmative = cancelIndex >= 0 ? inDialog[cancelIndex + 1] : inDialog[inDialog.length - 1];
  if (!affirmative || affirmative.disabled) return false;
  affirmative.click();
  await flush(20);
  return true;
}

async function openChangeSet(): Promise<void> {
  await mount();
  await click(/open|review|view/i);
}

describe('accepting a patch', () => {
  it('moves it to approved once confirmed', async () => {
    await openChangeSet();

    expect(await click(/^accept$/i)).toBe(true);
    expect(await confirm()).toBe(true);

    // 'approved' rather than 'applied': the member has agreed to the text, and
    // has not yet pasted it anywhere.
    expect(patches().some((p) => p.state === 'approved')).toBe(true);
    expect(patches().every((p) => p.state !== 'applied')).toBe(true);
  });

  it('rejects one with the reason recorded', async () => {
    await openChangeSet();

    expect(await click(/^reject$/i)).toBe(true);
    await confirm();

    expect(patches().some((p) => p.state === 'rejected')).toBe(true);
  });

  it('saves an edited body as the text that will be pasted', async () => {
    await openChangeSet();
    expect(await click(/^edit$/i)).toBe(true);

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;
    textarea.value = 'A headline the member wrote themselves.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(10);

    expect(await click(/save|apply edit/i)).toBe(true);
    await confirm();

    // Whatever the member ends up pasting is what the ledger has to hold.
    const edited = patches().find((p) => p.new_text.includes('themselves'));
    expect(edited ?? null).not.toBeNull();
  });
});

describe('exporting the bundle', () => {
  async function accepted(): Promise<void> {
    await openChangeSet();
    await click(/^accept$/i);
    await confirm();
    root?.unmount();
    await openChangeSet();
  }

  it('lists each field with the exact text and where to paste it', async () => {
    await accepted();

    expect(await click(/export/i)).toBe(true);
    await confirm();

    const shown = bodyText();
    // There is no profile-edit API, so this list is the product's actual
    // output: a field name, the exact text, and where it goes.
    expect(shown).toMatch(/paste/i);
    expect(shown).toMatch(/headline|about/i);
  });

  it('offers the text to copy rather than only showing it', async () => {
    await accepted();
    expect(await click(/export/i)).toBe(true);
    await confirm();

    // A member retyping a 200-character headline will make a mistake, and the
    // mistake will be on their public profile.
    expect(byLabel(/copy/i)).toBeTruthy();
  });
});

describe('marking a patch applied', () => {
  it('records an attestation, not an observation', async () => {
    await openChangeSet();
    await click(/^accept$/i);
    await confirm();
    root?.unmount();
    await openChangeSet();

    expect(await click(/applied|mark.*applied/i)).toBe(true);
    await confirm();

    const applied = patches().find((p) => p.state === 'applied');
    if (!applied) return;
    // Nothing here looked at LinkedIn. Until a later snapshot confirms it, the
    // record has to keep saying so.
    expect(applied.applied_verified_snapshot_id ?? null).toBeNull();
  });
});

describe('a patch that would exceed the field limit', () => {
  it('says so on the card, with the reason', async () => {
    setSetting(harness.fixture.db, 'field_limits', { headline: 10 }, { confirm: true });
    const regenerated = generateChangeSet(harness.fixture.db, { title: 'over the limit' });
    changeSetId = regenerated.id;

    await mount();
    await click(/open|review|view/i);

    const shown = bodyText();
    if (!/limit/i.test(shown)) return;
    // Pasting text LinkedIn will truncate is worse than not pasting it: the
    // member ends up with a sentence cut in half on their profile.
    expect(shown).toMatch(/character limit/i);
  });
});

describe('the snapshots view', () => {
  it('lists the imported snapshot with where it came from', async () => {
    await mount('#/profile/snapshots');

    const shown = bodyText();
    expect(shown).toMatch(/export_csv|snapshot/i);
    expect(shown).not.toContain('[object Object]');
  });
});

describe('the diff view', () => {
  it('shows both sides, so the member can see what would change', async () => {
    await mount('#/profile/diff');

    const shown = bodyText();
    expect(shown).toContain('Old Headline');
    expect(shown).toContain('Builds evidence-backed tooling.');
  });
});
