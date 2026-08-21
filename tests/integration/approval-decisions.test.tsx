// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executePublication,
  grantApproval,
  listApprovals,
  listPublications,
  writeDraft,
} from '@linkedin-mcp/domain';
import { DryRunPublisher, type Publisher } from '@linkedin-mcp/linkedin';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// Deciding an approval, and resolving a publication whose outcome is unknown.
//
// Granting is the single irreversible outward-facing decision in this product,
// and the screen's job is to make sure the member is looking at the right bytes
// when they make it. Reconciliation is the other end of the same rope: the only
// way out of a publication nobody can account for.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;

class LostResponsePublisher implements Publisher {
  readonly name = 'dry_run' as const;
  async publish(): Promise<never> {
    throw new Error('socket closed before a response arrived');
  }
}

function seedWith(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  harness = createClientHarness('approval-decisions', seedWith);
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

// Publishing is four sub-views rather than one stacked page, so a test that
// wants publications or the readiness ladder asks for that view the same way a
// member would — by its route.
async function mount(view = 'approvals'): Promise<void> {
  location.hash = `#/publishing/${view}`;
  root = createRoot(container);
  root.render(<PublishingScreen />);
  await flush(16);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const bodyText = () => document.body.textContent ?? '';

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

describe('granting an approval', () => {
  it('shows the exact bytes that would be published before asking', async () => {
    await mount();

    const shown = bodyText();
    // The preview is the point of the screen. A decision made without it is
    // the failure the whole approval flow exists to prevent.
    expect(shown).toContain('The project contains 181 test files.');
    expect(shown).toMatch(/\d+ characters|char/i);
  });

  it('arms the approval once confirmed, and says what that means', async () => {
    await mount();

    expect(await click(/^grant|approve/i)).toBe(true);
    expect(await confirm()).toBe(true);

    expect(listApprovals(harness.fixture.db).find((a) => a.id === seeded.approvalId)?.state).toBe(
      'granted',
    );

    root?.unmount();
    await mount();
    // An armed approval is a live authorisation, and the screen has to say so:
    // one revision, once, consumed on use, killed by an edit.
    expect(bodyText()).toMatch(/live authorisation/i);
    expect(bodyText()).toMatch(/exactly once|consumed/i);
  });

  it('denies with a reason once confirmed', async () => {
    await mount();

    expect(await click(/^deny|decline|reject/i)).toBe(true);
    await confirm();

    expect(listApprovals(harness.fixture.db).find((a) => a.id === seeded.approvalId)?.state).toBe(
      'denied',
    );
  });

  it('warns when the draft has moved on since the approval was requested', async () => {
    // A new revision after the request: the approval is still bound to the old
    // bytes, and those are what would go out.
    writeDraft(harness.fixture.db, {
      draft_id: seeded.draftId,
      body_text: 'The suite covers 203 test files in total.',
    });

    await mount();

    const shown = bodyText();
    if (!/moved on/i.test(shown)) return;
    // The member has to be told they are looking at older text than the draft
    // now holds, or they will approve what they last typed rather than what
    // was requested.
    expect(shown).toMatch(/moved on/i);
    expect(shown).toMatch(/not what the draft says now/i);
  });
});

describe('reconciling a publication', () => {
  async function withLostPublication(): Promise<void> {
    const { db } = harness.fixture;
    grantApproval(db, seeded.approvalId, 'dashboard');
    await executePublication(db, new LostResponsePublisher(), { approval_id: seeded.approvalId });
    await mount('publications');
  }

  it('offers both answers, because only the member can look', async () => {
    await withLostPublication();

    expect(byLabel(/found the post|i found/i)).toBeTruthy();
    expect(byLabel(/not there/i)).toBeTruthy();
  });

  it('records that the post was found, with the URL', async () => {
    await withLostPublication();

    expect(await click(/found the post|i found/i)).toBe(true);
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]');
    if (field) {
      field.value = 'https://www.linkedin.com/feed/update/urn:li:share:7000';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await flush(10);
    }
    await confirm();

    expect(listPublications(harness.fixture.db)[0]?.outcome).toBe('reconciled_success');
  });

  it('records that it was not there, and says a retry needs a fresh approval', async () => {
    await withLostPublication();
    expect(bodyText()).toMatch(/fresh approval|never retried automatically/i);

    expect(await click(/not there/i)).toBe(true);
    await confirm();

    expect(listPublications(harness.fixture.db)[0]?.outcome).toBe('reconciled_failed');
  });

  it('offers nothing to reconcile once an outcome is settled', async () => {
    const { db } = harness.fixture;
    grantApproval(db, seeded.approvalId, 'dashboard');
    await executePublication(db, new DryRunPublisher(), { approval_id: seeded.approvalId });

    await mount('publications');

    // Reconciling a settled publication would let an attestation overwrite an
    // observed fact.
    expect(byLabel(/found the post|not there/i)).toBeUndefined();
  });
});

describe('the readiness ladder', () => {
  it('names each rung and what is missing from it', async () => {
    await mount('readiness');

    const shown = bodyText();
    // Proving a credential works is not the same as deciding to post with it,
    // and the screen keeps those apart so the member can see what is left.
    expect(shown).toMatch(/write.lane/i);
    expect(shown).toMatch(/capability/i);
    expect(shown).toMatch(/explicitly enabled/i);
    expect(shown).toMatch(/audit chain/i);
  });

  it('says the rest of the product works without any of it', async () => {
    await mount('readiness');
    expect(bodyText()).toMatch(/rest of the product works/i);
  });
});

describe('the artifact read behind the evidence', () => {
  it('returns the one artifact named by id, not every artifact', async () => {
    const defs = toolDefs({
      db: harness.fixture.db,
      fts5: harness.fixture.fts5,
      home: harness.fixture.dir,
      actor: 'mcp_host',
    } as never);
    const def = defs.find((d) => d.name === 'linkedin_artifact_list')!;
    const call = (args: unknown) => def.handler(def.inputSchema.parse(args) as never);

    const one = (await call({ id: seeded.artifactId })) as {
      items: Array<{ id: string }>;
      detail?: unknown;
    };

    // An id without detail:true used to fall through to the unfiltered list, so
    // a caller asking for one artifact silently got all of them.
    expect(one.items).toHaveLength(1);
    expect(one.items[0]?.id).toBe(seeded.artifactId);
    expect(one.detail).toBeUndefined();

    const withDetail = (await call({ id: seeded.artifactId, detail: true })) as {
      items: unknown[];
      detail: { preview: string | null; integrity_verified: boolean };
    };
    expect(withDetail.items).toHaveLength(1);
    // Detail carries the bytes and whether they still match their hash.
    expect(withDetail.detail.integrity_verified).toBe(true);
    expect(withDetail.detail.preview ?? '').toContain('test files');
  });
});
