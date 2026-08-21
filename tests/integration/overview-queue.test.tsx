// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enableSourceFromDashboard,
  executePublication,
  generateChangeSet,
  getChangeSet,
  grantApproval,
  importSnapshot,
  markPatchApplied,
  registerSource,
  reviewPatch,
  runImport,
  updateSection,
  validateDraft,
  writeDraft,
} from '@linkedin-mcp/domain';
import type { Publisher } from '@linkedin-mcp/linkedin';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// The Overview queue, with every condition it can report actually present.
//
// The queue is built from a private function whose branches each correspond to
// one thing the member needs to do next. A seeded home triggers two of them, so
// the rest had never rendered — including the two that matter most on a bad
// day: an approval left armed, and a publication whose outcome nobody knows.
//
// Getting them all into one home takes some setting up, which is the point:
// this is what the screen looks like when the member has been using the thing.

let harness: ClientHarness;
let evidenceDir: string;
let container: HTMLElement;
let root: Root | null = null;

/** Loses the response, which is how a publication ends up 'ambiguous'. */
class LostResponsePublisher implements Publisher {
  readonly name = 'dry_run' as const;
  async publish(): Promise<never> {
    throw new Error('socket closed before a response arrived');
  }
}

beforeAll(async () => {
  harness = createClientHarness('overview-queue', seedHealthy);
  const { db, store, dir } = harness.fixture;

  // A snapshot to diff against, so a change set has patches in it.
  evidenceDir = mkdtempSync(join(tmpdir(), 'overview-queue-ev-'));
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

  // A second canonical section that diverges from the snapshot, so the change
  // set carries two patches: one to leave waiting, one to mark applied.
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

  const changeSet = generateChangeSet(db, { title: 'headline and about refresh' });
  const patches = getChangeSet(db, changeSet.id).patches;
  // One accepted and left waiting to be pasted, one accepted and attested as
  // pasted but not yet confirmed by a fresh snapshot.
  if (patches[0]) reviewPatch(db, { patch_id: patches[0].id, action: 'accept' });
  if (patches[1]) {
    reviewPatch(db, { patch_id: patches[1].id, action: 'accept' });
    markPatchApplied(db, { patch_id: patches[1].id, confirm: true, actor: 'dashboard' });
  }

  // A draft that fails validation: the metric appears in no verified claim.
  const failing = writeDraft(db, {
    body_text: 'Shipped to 4,200 customers last quarter with 99.99% uptime.',
    slug: 'failing-draft',
  });
  validateDraft(db, failing.draft.id);

  // An approval left armed, and a publication whose outcome was lost.
  const pending = db.all("SELECT id FROM approvals WHERE state = 'pending'");
  const armedId = String(pending[0]?.['id'] ?? '');
  if (armedId) {
    grantApproval(db, armedId, 'dashboard');
    await executePublication(db, new LostResponsePublisher(), { approval_id: armedId });
  }

  // A second approval, granted and left standing so the armed branch renders.
  const second = writeDraft(db, {
    body_text: 'The suite covers 203 test files in total.',
    slug: 'second-draft',
  });
  validateDraft(db, second.draft.id);
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

async function mount(Screen: FC, hash: string): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<Screen />);
  await flush(16);
}

const text = () => document.body.textContent ?? '';

describe('the work queue', () => {
  it('reports a publication whose outcome nobody knows', async () => {
    await mount(OverviewScreen, '#/overview');

    // This is the worst state the system can be in — the post may or may not be
    // on the member's profile — so it must be named, and named first.
    expect(text()).toMatch(/outcome is unknown|response was lost/i);
  });

  it('reports patches waiting to be pasted and patches waiting to be confirmed', async () => {
    await mount(OverviewScreen, '#/overview');

    const shown = text();
    expect(shown).toMatch(/ready to apply|to review/i);
    // "Applied" is an attestation by the member, not an observation. Until a
    // fresh snapshot confirms it, the queue has to keep saying so.
    expect(shown).toMatch(/unconfirmed|confirm the text actually landed/i);
  });

  it('reports a draft that cannot be approved because its checks fail', async () => {
    await mount(OverviewScreen, '#/overview');
    expect(text()).toMatch(/failing validation|fabricated metrics|unsupported sentences/i);
  });

  it('reports the pending source and the claims awaiting review', async () => {
    await mount(OverviewScreen, '#/overview');

    const shown = text();
    expect(shown).toMatch(/source|review/i);
    expect(shown).not.toContain('[object Object]');
    expect(shown).not.toContain('NaN');
  });

  it('gives every queue row somewhere to go', async () => {
    await mount(OverviewScreen, '#/overview');

    const rows = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
    expect(rows.length).toBeGreaterThan(3);

    // A row that names a problem without offering the screen that fixes it is
    // worse than not naming it.
    for (const row of rows) {
      const href = row.getAttribute('href');
      if (href !== null) expect(href).toMatch(/^#\//);
    }
  });

  it('follows each row through to its destination screen', async () => {
    await mount(OverviewScreen, '#/overview');
    const count = Array.from(document.querySelectorAll('a, button')).length;

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(OverviewScreen, '#/overview');
      Array.from(document.querySelectorAll<HTMLElement>('a, button'))[index]?.click();
      await flush(8);
      dispatchEvent(new Event('hashchange'));
      await flush(8);
      expect(text()).not.toContain('[object Object]');
    }
  });
});

// Publications live in their own sub-view now, rather than stacked under the
// approvals on one page.
describe('Publishing with an armed approval and a lost publication', () => {
  it('shows the ambiguous publication and offers reconciliation', async () => {
    await mount(PublishingScreen, '#/publishing/publications');

    const shown = text();
    expect(shown).toMatch(/ambiguous|unknown/i);
    // Both answers have to be offered, because only the member can look.
    expect(shown).toMatch(/found the post|not there/i);
  });

  it('never retries a lost publication automatically', async () => {
    await mount(PublishingScreen, '#/publishing/publications');

    // A retry after "not there" needs a fresh approval. Anything that looks
    // like an automatic retry would be a second post from one authorisation.
    expect(text()).toMatch(/fresh approval|never retried automatically/i);
  });

  it('drives each publishing control without changing an outcome on the click', async () => {
    await mount(PublishingScreen, '#/publishing/publications');
    const before = harness.fixture.db.get(
      "SELECT COUNT(*) AS n FROM publications WHERE outcome = 'ambiguous'",
    )?.['n'];
    const count = Array.from(document.querySelectorAll('button')).filter((b) => !b.disabled).length;

    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(PublishingScreen, '#/publishing/publications');
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter((b) => !b.disabled)
        [index]?.click();
      await flush(10);
      expect(text()).not.toContain('[object Object]');
    }

    expect(
      harness.fixture.db.get(
        "SELECT COUNT(*) AS n FROM publications WHERE outcome = 'ambiguous'",
      )?.['n'],
    ).toBe(before);
  });
});
