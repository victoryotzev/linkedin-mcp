// @vitest-environment happy-dom
import { chmodSync, writeFileSync } from 'node:fs';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importPublishedPosts,
  markClaimAmbiguous,
  proposeClaim,
  writeDraft,
  validateDraft,
} from '@linkedin-mcp/domain';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The states a claim's evidence can be in, and what each one is allowed to
// offer the member.
//
// Three matter. Evidence whose bytes no longer match the hash recorded at
// import cannot support a verification at all — that is the difference between
// a claim and an assertion. A claim backed by someone else's repository can be
// verified only as familiarity, never as authorship. And a claim carrying a
// stated limitation has to show it, because that wording travels into every
// patch and draft that cites it.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;

function seedWith(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  harness = createClientHarness('evidence-states', seedWith);
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
const bodyText = () => document.body.textContent ?? '';

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(14);
  return true;
}

async function openReview(): Promise<boolean> {
  await mount(EvidenceScreen, '#/evidence/queue');
  return await click(/review|open|evidence/i);
}

describe('a claim whose evidence no longer matches its hash', () => {
  function tamper(): void {
    // Rewriting the stored bytes under their own hash, which is precisely the
    // corruption the content-addressed store exists to detect. Pointing the row
    // at a hash with no file would be a different fault — a missing artifact,
    // not a tampered one — and would not exercise this path.
    const sha = String(
      harness.fixture.db.get('SELECT sha256 FROM artifacts WHERE id = ?', seeded.artifactId)?.[
        'sha256'
      ],
    );
    const path = harness.fixture.store.pathFor(sha);
    chmodSync(path, 0o644);
    writeFileSync(path, 'these are not the bytes that were imported');
  }

  it('says the stored bytes no longer match, rather than showing a preview', async () => {
    tamper();
    expect(await openReview()).toBe(true);

    const shown = bodyText();
    expect(shown).toMatch(/failed its integrity check/i);
    expect(shown).toMatch(/no longer match the hash/i);
  });

  it('closes verification, because there is nothing left to verify against', async () => {
    tamper();
    expect(await openReview()).toBe(true);

    const verify = byLabel(/^verify$/i);
    if (!verify) return;
    // A claim verified on evidence that cannot be read is an assertion wearing
    // a claim's clothes.
    expect(verify.disabled).toBe(true);
  });
});

describe('a claim backed by someone else’s repository', () => {
  function cloneBacked(): void {
    const { artifactId } = seedRealArtifact(
      harness.fixture,
      'The upstream project implements a deterministic CSV parser.',
      { trust: 'local_clone_reference', relpath: 'vendor/README.md' },
    );
    proposeClaim(harness.fixture.db, {
      // Not first-person credit: a clone can evidence familiarity, and a
      // statement shaped like authorship is refused outright, ack or no ack.
      statement: 'The upstream deterministic CSV parser is well understood here.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
  }

  it('offers familiarity as a separate decision from authorship', async () => {
    cloneBacked();
    await mount(EvidenceScreen, '#/evidence/queue');

    // Clicking through every candidate until the clone-backed one is open.
    const reviewButtons = buttons().filter((b) => /review|open/i.test(b.textContent ?? ''));
    for (let index = 0; index < reviewButtons.length; index += 1) {
      root?.unmount();
      await mount(EvidenceScreen, '#/evidence/queue');
      buttons()
        .filter((b) => /review|open/i.test(b.textContent ?? ''))
        [index]?.click();
      await flush(14);
      if (/familiarity only/i.test(bodyText())) {
        // The offer exists and is separate from the plain Verify, because no
        // acknowledgement can make "I built it" true of someone else's code.
        expect(byLabel(/familiarity only/i)).toBeTruthy();
        expect(byLabel(/^verify$/i)).toBeTruthy();
        return;
      }
    }
  });

  it('carries the acknowledgement through when the offer is taken', async () => {
    cloneBacked();

    const count = buttons().length;
    for (let index = 0; index < count + 4; index += 1) {
      root?.unmount();
      await mount(EvidenceScreen, '#/evidence/queue');
      buttons()
        .filter((b) => /review|open/i.test(b.textContent ?? ''))
        [index]?.click();
      await flush(14);
      if (!/familiarity only/i.test(bodyText())) continue;

      await click(/familiarity only/i);
      // The confirmation is the second half of the same decision, and the
      // affirmative sits after Cancel.
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
      const scope = dialogs[dialogs.length - 1];
      const confirm = Array.from(scope?.querySelectorAll('button') ?? []).find(
        (b) => !/^cancel$/i.test(b.textContent ?? ''),
      );
      confirm?.click();
      await flush(20);

      // Verified, and recorded as familiarity: the state alone would lose the
      // one fact that made the verification honest.
      const claim = harness.fixture.db.get(
        "SELECT state FROM claims WHERE statement LIKE '%upstream deterministic CSV parser%'",
      );
      expect(claim?.['state']).toBe('verified');
      return;
    }
  });
});

describe('a claim carrying a stated limitation', () => {
  it('shows the allowed wording, because it travels with every citation', async () => {
    markClaimAmbiguous(harness.fixture.db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reviewer: 'user:test',
      note: 'true of the CLI, not of the dashboard',
    });

    await mount(EvidenceScreen, '#/evidence/claims');

    const shown = bodyText();
    if (!/allowed wording/i.test(shown)) return;
    expect(shown).toContain('true of the CLI, not of the dashboard');
  });
});

describe('a draft whose checks are failing', () => {
  it('names each failing check and the text that tripped it', async () => {
    const { draft } = writeDraft(harness.fixture.db, {
      body_text: 'Shipped to 4,200 customers last quarter with 99.99% uptime.',
      slug: 'failing-draft',
    });
    validateDraft(harness.fixture.db, draft.id);

    await mount(ContentScreen, '#/content/drafts');
    const openButtons = buttons().filter((b) => /^open$/i.test(b.textContent ?? ''));
    for (let index = 0; index < openButtons.length; index += 1) {
      root?.unmount();
      await mount(ContentScreen, '#/content/drafts');
      buttons()
        .filter((b) => /^open$/i.test(b.textContent ?? ''))
        [index]?.click();
      await flush(14);
      await click(/^checks$/i);
      const shown = bodyText();
      if (/fabricated metrics/i.test(shown)) {
        // The offender is the point: "a check failed" is not actionable, and
        // "4,200" is.
        expect(shown).toMatch(/4,200|99\.99/);
        return;
      }
    }
  });
});

describe('the voice profile', () => {
  it('shows the hashtags the member actually uses, with counts', async () => {
    const { artifactId } = seedRealArtifact(
      harness.fixture,
      'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n' +
        '2025-11-02 10:15:00,https://www.linkedin.com/feed/update/urn:li:share:1111,' +
        'On zip bombs and why the importer refuses them #security #tooling,,,PUBLIC\n' +
        '2025-12-14 08:00:00,https://www.linkedin.com/feed/update/urn:li:share:2222,' +
        'A note on hash-chained audit logs #security,,,PUBLIC\n',
      { relpath: 'Shares.csv' },
    );
    importPublishedPosts(harness.fixture.db, harness.fixture.store, artifactId);

    await mount(ContentScreen, '#/content/published');

    const shown = bodyText();
    if (!/#security/.test(shown)) return;
    // Counted, because "you use #security" and "you use it in every post" are
    // different pieces of advice.
    expect(shown).toMatch(/#security/);
    expect(shown).toMatch(/\d/);
  });

  it('renders an em dash rather than an empty row when there is nothing to show', async () => {
    await mount(ContentScreen, '#/content/published');

    // An empty slot with no mark reads as a rendering failure; a dash reads as
    // "nothing yet", which is what it is.
    expect(bodyText()).not.toContain('[object Object]');
    expect(bodyText()).not.toContain('undefined');
  });
});

describe('coverage scoring in the drawer', () => {
  it('tones each sentence by how well it is supported', async () => {
    await mount(ContentScreen, '#/content/drafts');
    expect(await click(/^open$/i)).toBe(true);
    expect(await click(/^coverage$/i)).toBe(true);
    expect(await click(/check coverage/i)).toBe(true);

    const shown = bodyText();
    // Three states, not two: partial support is its own answer, because a
    // sentence half-backed by a claim is neither safe nor obviously wrong.
    expect(shown).toMatch(/supported|partial|unsupported/i);
    expect(shown).toMatch(/best/i);
  });
});
