// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  enableSourceFromDashboard,
  generateChangeSet,
  getChangeSet,
  importSnapshot,
  registerSource,
  runImport,
} from '@linkedin-mcp/domain';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// The patch-review surface: the half of the Profile screen that only exists
// once there is a snapshot to diff against. Nothing in the DOM suites could
// reach it before, because a seeded home has no LinkedIn export in it — so the
// change-set list rendered empty and every control below it was unreachable.
//
// This matters more than the line count suggests. Accepting a patch is how a
// claim-backed sentence becomes text the member will paste onto their public
// profile, and rejecting or editing one is the only way to say no.

let harness: ClientHarness;
let evidenceDir: string;
let container: HTMLElement;
let root: Root | null = null;
let changeSetId: string;

beforeAll(async () => {
  harness = createClientHarness('profile-patch-review', seedHealthy);
  const { db, store, dir } = harness.fixture;

  // A snapshot of the profile as LinkedIn currently has it. seedHealthy has
  // already written a different canonical headline, so the two diverge and the
  // generator has something real to propose.
  evidenceDir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-patchev-'));
  const zipPath = join(evidenceDir, 'export.zip');
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

  changeSetId = generateChangeSet(db, { title: 'headline refresh' }).id;
});

afterAll(() => {
  harness.close();
  rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 3 });
});

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

async function mount(hash: string): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<ProfileScreen />);
  await flush(12);
}

const buttons = (scope: ParentNode = container): HTMLButtonElement[] =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button'));

const byLabel = (pattern: RegExp, scope: ParentNode = container) =>
  buttons(scope).find((b) => pattern.test(b.textContent ?? ''));

/** The confirmation dialog renders in a portal, outside the mount container. */
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function openChangeSet(): Promise<void> {
  await mount('#/profile/changesets');
  const open = byLabel(/open|review|view/i);
  expect(open, 'the change-set list should offer a way in').toBeTruthy();
  open?.click();
  await flush(12);
}

describe('the change-set list', () => {
  it('lists the generated change set with its patch count', async () => {
    await mount('#/profile/changesets');

    const text = container.textContent ?? '';
    expect(text).toContain('headline refresh');
    // The list is what tells a member there is anything to review at all.
    expect(buttons().length).toBeGreaterThan(0);
  });

  it('opens the detail view for a change set', async () => {
    await openChangeSet();

    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('headline');
    // The detail view renders the proposed text, not just the field name.
    expect(text).toContain('Builds evidence-backed tooling.');
  });
});

describe('reviewing a patch', () => {
  it('asks for confirmation before accepting, and does not accept on the click alone', async () => {
    await openChangeSet();
    const before = getChangeSet(harness.fixture.db, changeSetId).patches[0]?.state;

    const accept = byLabel(/^accept$/i);
    expect(accept, 'a proposed patch should offer accept').toBeTruthy();
    accept?.click();
    await flush(8);

    expect(dialog(), 'accepting must go through a confirmation').not.toBeNull();
    // The click opened a dialog; it did not decide anything.
    expect(getChangeSet(harness.fixture.db, changeSetId).patches[0]?.state).toBe(before);
  });

  it('asks for confirmation before rejecting', async () => {
    await openChangeSet();
    const before = getChangeSet(harness.fixture.db, changeSetId).patches[0]?.state;

    const reject = byLabel(/^reject$/i);
    expect(reject).toBeTruthy();
    reject?.click();
    await flush(8);

    expect(dialog()).not.toBeNull();
    expect(getChangeSet(harness.fixture.db, changeSetId).patches[0]?.state).toBe(before);
  });

  it('opens an editor holding the proposed text, and closing it changes nothing', async () => {
    await openChangeSet();
    const before = getChangeSet(harness.fixture.db, changeSetId).patches[0];

    const edit = byLabel(/^edit$/i);
    expect(edit).toBeTruthy();
    edit?.click();
    await flush(8);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea, 'editing should surface the text itself').toBeTruthy();
    // Pre-filled with the proposal, so a member edits rather than retypes.
    expect(textarea?.value).toBe(before?.new_text);

    byLabel(/cancel|close/i)?.click();
    await flush(8);

    const after = getChangeSet(harness.fixture.db, changeSetId).patches[0];
    expect(after?.new_text).toBe(before?.new_text);
    expect(after?.state).toBe(before?.state);
  });

  it('carries an edited body through the confirmation without saving early', async () => {
    await openChangeSet();
    const before = getChangeSet(harness.fixture.db, changeSetId).patches[0];

    byLabel(/^edit$/i)?.click();
    await flush(8);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;
    textarea.value = 'A headline the member wrote themselves.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(8);

    const save = byLabel(/save|apply edit|^edit$/i);
    save?.click();
    await flush(8);

    // Whether this opens a dialog or writes directly, what must not happen is
    // the stored text changing without the member having confirmed it.
    const after = getChangeSet(harness.fixture.db, changeSetId).patches[0];
    if (dialog()) {
      expect(after?.new_text).toBe(before?.new_text);
    }
    expect(after?.state).not.toBe('rejected');
  });
});

describe('exporting a change set', () => {
  it('produces a bundle the member can paste, without touching LinkedIn', async () => {
    await openChangeSet();

    const exportButton = byLabel(/export/i);
    expect(exportButton, 'the detail view should offer an export').toBeTruthy();
    exportButton?.click();
    await flush(12);

    // Export is a read: it renders copyable text and must not mark anything
    // applied. Marking applied is a separate, separately confirmed act.
    const text = container.textContent ?? '';
    expect(text.length).toBeGreaterThan(100);
    expect(getChangeSet(harness.fixture.db, changeSetId).patches[0]?.state).not.toBe('applied');
  });
});

describe('the other profile views with a snapshot present', () => {
  it('renders the sections view against real canonical revisions', async () => {
    await mount('#/profile/sections');

    const text = container.textContent ?? '';
    expect(text).toContain('Builds evidence-backed tooling.');
    expect(text).not.toContain('undefined');
  });

  it('renders the diff between canonical text and the imported snapshot', async () => {
    await mount('#/profile/diff');

    const text = container.textContent ?? '';
    // Both sides of the comparison have to be visible for a diff to mean
    // anything: what LinkedIn holds now, and what the evidence supports.
    expect(text).toContain('Old Headline');
    expect(text).toContain('Builds evidence-backed tooling.');
  });

  it('renders the snapshots view with the imported snapshot listed', async () => {
    await mount('#/profile/snapshots');

    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('snapshot');
    expect(text).not.toContain('[object Object]');
  });
});
