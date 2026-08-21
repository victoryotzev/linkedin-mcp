// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enableSourceFromDashboard,
  generateChangeSet,
  importPublishedPosts,
  importSnapshot,
  proposeClaim,
  registerSource,
  runImport,
  verifyClaim,
  writeDraft,
} from '@linkedin-mcp/domain';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { makeZip } from '../helpers/makeZip.ts';
import { seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The last few screen states, each of which needs a particular record to exist.
//
// A queue that ranks work is only useful if every kind of work can reach it, so
// a proposed profile patch has to appear alongside claims and approvals. A
// draft that has never been validated has to say so rather than showing an
// empty checklist. And an opportunity has to carry the wording constraint from
// the claim it came from, because that constraint is the whole reason the claim
// was allowed to be verified.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;
let evidence: string;

function seed(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-scr-'));
  harness = createClientHarness('screen-remainder', seed);
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

async function mount(Screen: FC, hash: string): Promise<void> {
  location.hash = hash;
  root = createRoot(container);
  root.render(<Screen />);
  await flush(16);
}

const bodyText = () => document.body.textContent ?? '';
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));

async function click(pattern: RegExp): Promise<boolean> {
  const button = buttons().find((b) => pattern.test(b.textContent ?? ''));
  if (!button || button.disabled) return false;
  button.click();
  await flush(16);
  return true;
}

/** Imports a LinkedIn export so there is a snapshot to diff against. */
async function importedSnapshot(headline: string): Promise<void> {
  const zipPath = join(evidence, `export-${headline.length}.zip`);
  writeFileSync(
    zipPath,
    makeZip([
      {
        name: 'Profile.csv',
        data: Buffer.from(
          'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
            `Alex,Rivera,,,,${headline},Old summary.,Software,,Ghent,,,\n`,
        ),
      },
    ]),
  );
  const source = registerSource(harness.fixture.db, {
    path: zipPath,
    kind: 'linkedin_export',
    trust: 'personal_doc',
    label: 'export',
    dataHome: harness.fixture.dir,
  });
  enableSourceFromDashboard(harness.fixture.db, source.id);
  await runImport(harness.fixture.db, harness.fixture.store, source.id);
  importSnapshot(harness.fixture.db, harness.fixture.store, source.id);
}

describe('the queue when a profile patch is waiting', () => {
  it('ranks it alongside the claims and approvals', async () => {
    await importedSnapshot('An older headline that no longer describes the work');
    generateChangeSet(harness.fixture.db, { title: 'headline refresh' });

    await mount(OverviewScreen, '#/overview/queue');

    const shown = bodyText();
    // A queue that only knew about claims would leave a member's profile edits
    // sitting unreviewed with nothing pointing at them.
    expect(shown).toMatch(/profile patch/i);
    expect(shown).toMatch(/verified claims/i);
  }, 60_000);

  it('opens the destination the item points at', async () => {
    await importedSnapshot('An older headline that no longer describes the work');
    generateChangeSet(harness.fixture.db, { title: 'headline refresh' });
    await mount(OverviewScreen, '#/overview/queue');

    expect(await click(/^open$/i)).toBe(true);

    // The queue is a set of front doors; an item that did not move anywhere
    // would be a list of complaints.
    expect(location.hash).not.toBe('#/overview/queue');
  }, 60_000);
});

describe('the readiness list on the overview', () => {
  it('names the blockers standing in front of each capability', async () => {
    await mount(OverviewScreen, '#/overview/readiness');

    const shown = bodyText();
    // The blocker names are what a member searches for; "not ready" alone sends
    // them to the issue tracker.
    expect(shown).toMatch(/blockers:/i);
    expect(shown).not.toContain('[object Object]');
  });
});

describe('a draft revision nobody has validated', () => {
  it('says so rather than showing an empty checklist', async () => {
    writeDraft(harness.fixture.db, {
      body_text: 'A second draft that has never been through the gates.',
      slug: 'never-validated',
    });

    await mount(ContentScreen, '#/content/drafts');
    const count = buttons().filter((b) => /^open$/i.test(b.textContent ?? '')).length;
    let found = false;
    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount(ContentScreen, '#/content/drafts');
      buttons()
        .filter((b) => /^open$/i.test(b.textContent ?? ''))
        [index]?.click();
      await flush(14);
      await click(/^checks$/i);
      if (!/has not been validated/i.test(bodyText())) continue;
      found = true;
      break;
    }

    // An empty checks list reads as "everything passed", which is the opposite
    // of what an unvalidated revision means.
    expect(found).toBe(true);
  });

  it('explains why approval is closed while the validation is stale', async () => {
    writeDraft(harness.fixture.db, {
      draft_id: seeded.draftId,
      body_text: 'The project contains 181 test files. And one more sentence besides.',
    });

    await mount(ContentScreen, '#/content/drafts');
    expect(await click(/^open$/i)).toBe(true);

    const request = buttons().find((b) => /request approval/i.test(b.textContent ?? ''));
    if (!request) return;
    expect(request.disabled).toBe(true);
    // The reason is the actionable half: re-validate, rather than "you cannot".
    expect(request.getAttribute('title') ?? '').toMatch(/validat/i);
  });
});

describe('coverage of a draft that is only partly supported', () => {
  it('tones each sentence separately rather than judging the whole post', async () => {
    writeDraft(harness.fixture.db, {
      draft_id: seeded.draftId,
      body_text:
        'The project contains 181 test files. It also cured my insomnia and rearranged my furniture.',
    });

    await mount(ContentScreen, '#/content/drafts');
    expect(await click(/^open$/i)).toBe(true);
    expect(await click(/^coverage$/i)).toBe(true);
    expect(await click(/check coverage/i)).toBe(true);

    const shown = bodyText();
    // One unsupported sentence in a post of supported ones is exactly the case
    // a whole-post verdict would hide.
    expect(shown).toMatch(/unsupported|partial/i);
    expect(shown).toMatch(/insomnia|furniture/i);
  });
});

describe('an opportunity drawn from a constrained claim', () => {
  it('carries the wording constraint and names the closest thing already said', async () => {
    const { artifactId } = seedRealArtifact(
      harness.fixture,
      'The CLI ships a masked credential prompt that never puts a token in argv.',
      { relpath: 'CLI.md' },
    );
    const claim = proposeClaim(harness.fixture.db, {
      statement: 'The control CLI prompts for credentials without putting them in argv.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(harness.fixture.db, {
      claim_id: claim.id,
      confirm: true,
      reviewer: 'user:test',
      limitations: 'true of the CLI, not of the dashboard',
    });

    const shares = seedRealArtifact(
      harness.fixture,
      'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n' +
        '2025-11-02 10:15:00,,The control CLI prompts for credentials without argv exposure,,,PUBLIC\n',
      { relpath: 'Shares.csv' },
    );
    importPublishedPosts(harness.fixture.db, harness.fixture.store, shares.artifactId);

    await mount(ContentScreen, '#/content/opportunities');

    const shown = bodyText();
    // The constraint is why the claim was allowed to be verified at all, so an
    // opportunity that dropped it would invite a post the evidence does not
    // support.
    expect(shown).toMatch(/wording constraint/i);
    expect(shown).toContain('true of the CLI, not of the dashboard');
    expect(shown).toMatch(/closest prior/i);
  }, 60_000);
});
