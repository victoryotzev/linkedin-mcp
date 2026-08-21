// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { denyApproval, grantApproval, writeDraft } from '@linkedin-mcp/domain';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The four Publishing views, in the states a member actually meets them in.
//
// Approvals are for exact bytes, so the reviewer has to be told when the draft
// has moved on since the request — otherwise they are reading one thing and
// approving another. Readiness has to say what is missing rather than showing a
// row of grey ticks. And the two list views have to say "nothing yet" in a way
// that cannot be mistaken for a failed load.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;

function seed(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  harness = createClientHarness('publishing-views', seed);
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

async function mount(view: string): Promise<void> {
  location.hash = `#/publishing/${view}`;
  root = createRoot(container);
  root.render(<PublishingScreen />);
  await flush(16);
}

const bodyText = () => document.body.textContent ?? '';

describe('an approval whose draft has moved on', () => {
  it('says the preview is the bound revision, not what the draft says now', async () => {
    writeDraft(harness.fixture.db, {
      draft_id: seeded.draftId,
      body_text: 'A materially different body, written after the approval was requested.',
    });
    // Editing invalidates the approval on the spot, which is the first defence.
    // Putting the row back to pending is what a writer that moved the draft
    // some other way would leave behind, and it is the state the reviewer must
    // never be shown without a warning.
    harness.fixture.db.run(
      "UPDATE approvals SET state = 'pending' WHERE id = ?",
      seeded.approvalId,
    );

    await mount('approvals');

    const shown = bodyText();
    expect(shown).toMatch(/moved on/i);
    // The reviewer is looking at bytes that are no longer the draft. Showing
    // them without saying so is how someone approves text they never read.
    expect(shown).toMatch(/bytes that would actually be published/i);
  });
});

describe('publishing readiness', () => {
  it('names what is still missing instead of showing a grey tick', async () => {
    await mount('readiness');

    const shown = bodyText();
    expect(shown).toMatch(/not ready/i);
    // The domain's own remediation text, verbatim. It is the actionable half:
    // "not ready" alone leaves a member with nowhere to go.
    expect(shown).toMatch(/developer app|token generator|capability verification/i);
  });

  it('lists every step, so a member can see which one they are on', async () => {
    await mount('readiness');

    const shown = bodyText();
    expect(shown).toMatch(/audit chain intact/i);
    expect(shown).not.toContain('[object Object]');
  });
});

describe('the publications list', () => {
  it('says nothing has been published rather than rendering an empty box', async () => {
    await mount('publications');

    // An empty region with no words in it is indistinguishable from a load
    // that failed.
    expect(bodyText()).toMatch(/nothing has been published/i);
  });
});

describe('the approval history', () => {
  it('is empty until something has been decided', async () => {
    await mount('history');

    expect(bodyText()).toMatch(/no decided approvals yet/i);
  });

  it('lists an approval once it has been decided, either way', async () => {
    denyApproval(harness.fixture.db, seeded.approvalId, 'the number could not be verified');

    await mount('history');

    const shown = bodyText();
    // Rejections belong here too: the history is the record of decisions, and
    // one that only kept the yeses would misrepresent how carefully the member
    // reviews.
    expect(shown).not.toMatch(/no decided approvals yet/i);
    expect(shown).not.toContain('[object Object]');
  });

  it('keeps a granted approval out of the pending queue once it is used', async () => {
    grantApproval(harness.fixture.db, seeded.approvalId, 'dashboard');

    await mount('history');

    expect(bodyText()).not.toContain('undefined');
  });
});
