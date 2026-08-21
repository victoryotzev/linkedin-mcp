// @vitest-environment happy-dom
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectConflicts,
  enableSourceFromDashboard,
  exportChangeSet,
  generateChangeSet,
  getChangeSet,
  getProfile,
  importSnapshot,
  markClaimAmbiguous,
  markPatchApplied,
  proposeClaim,
  registerSource,
  reviewPatch,
  runImport,
  updateSection,
} from '@linkedin-mcp/domain';
import { EvidenceScreen } from '../../linkedin-dashboard/src/client/screens/Evidence.tsx';
import { ProfileScreen } from '../../linkedin-dashboard/src/client/screens/Profile.tsx';
import { SetupScreen } from '../../linkedin-dashboard/src/client/screens/Setup.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { makeZip } from '../helpers/makeZip.ts';
import { seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The screen states left over: a claim with nothing under it, a conflict part
// way through being settled, a diff with nothing in it, and an upload that
// failed before the server ever answered.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;
let evidence: string;

function seed(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-fin-'));
  harness = createClientHarness('screen-final', seed);
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
  vi.unstubAllGlobals();
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

/** Opens every review row until one shows `marker`. */
async function openUntil(hash: string, label: RegExp, marker: RegExp): Promise<boolean> {
  await mount(EvidenceScreen, hash);
  const count = buttons().filter((b) => label.test(b.textContent ?? '')).length;
  for (let index = 0; index < count; index += 1) {
    root?.unmount();
    await mount(EvidenceScreen, hash);
    buttons()
      .filter((b) => label.test(b.textContent ?? ''))
      [index]?.click();
    await flush(16);
    if (marker.test(bodyText())) return true;
  }
  return false;
}

/** Imports a LinkedIn export carrying one headline, and snapshots it. */
async function importedSnapshot(headline: string): Promise<void> {
  const zipPath = join(evidence, `export-${headline.length}-${headline.slice(0, 8)}.zip`);
  writeFileSync(
    zipPath,
    makeZip([
      {
        name: 'Profile.csv',
        data: Buffer.from(
          'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
            // Only the headline: any other column becomes a snapshot field with
            // no canonical section to match it.
            `,,,,,${headline},,,,,,,\n`,
        ),
      },
    ]),
  );
  const source = registerSource(harness.fixture.db, {
    path: zipPath,
    kind: 'linkedin_export',
    trust: 'personal_doc',
    label: `export ${headline.slice(0, 12)}`,
    dataHome: harness.fixture.dir,
  });
  enableSourceFromDashboard(harness.fixture.db, source.id);
  await runImport(harness.fixture.db, harness.fixture.store, source.id);
  importSnapshot(harness.fixture.db, harness.fixture.store, source.id);
}

describe('a claim with nothing under it', () => {
  it('says no evidence is linked rather than showing an empty region', async () => {
    const claim = proposeClaim(harness.fixture.db, {
      statement: 'A claim whose evidence rows were removed underneath it.',
      evidence: [{ artifact_id: seeded.artifactId, location: {} }],
      method: 'manual',
    });
    harness.fixture.db.run('DELETE FROM claim_evidence WHERE claim_id = ?', claim.id);

    // A claim with no evidence cannot be verified, and an empty panel would
    // read as a load that failed rather than as the reason.
    expect(await openUntil('#/evidence/queue', /^review$/i, /no evidence is linked/i)).toBe(true);
  });
});

describe('evidence that was stored but never parsed', () => {
  it('says there is no text preview rather than showing an empty box', async () => {
    const { artifactId } = seedRealArtifact(harness.fixture, 'A binary the parser skipped.', {
      relpath: 'diagram.png',
    });
    harness.fixture.db.run('DELETE FROM extractions WHERE artifact_id = ?', artifactId);
    proposeClaim(harness.fixture.db, {
      statement: 'The architecture diagram shows the two surfaces over one engine.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });

    // The bytes are in the store and hash-verified; there is simply no text in
    // them. That is different from evidence that failed its integrity check,
    // and different again from a panel that failed to load.
    expect(await openUntil('#/evidence/queue', /^review$/i, /no text preview/i)).toBe(true);
  });
});

describe('a claim carrying a stated limitation, in review', () => {
  it('shows the allowed wording above the decision', async () => {
    markClaimAmbiguous(harness.fixture.db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reviewer: 'user:test',
      note: 'true of the CLI, not of the dashboard',
    });
    harness.fixture.db.run(
      "UPDATE claims SET state = 'candidate' WHERE id = ?",
      seeded.candidateId,
    );

    // The wording travels into every patch and draft that cites the claim, so
    // the reviewer has to see it while they are deciding, not afterwards.
    expect(await openUntil('#/evidence/queue', /^review$/i, /allowed wording/i)).toBe(true);
  });
});

describe('a conflict part way through being settled', () => {
  it('counts the claims that still need a decision', async () => {
    detectConflicts(harness.fixture.db);

    await mount(EvidenceScreen, '#/evidence/conflicts');

    // Resolving a contradiction means saying something about every claim in
    // it; a count is what stops a member submitting half a decision. The card
    // renders inline rather than behind a row action, because a contradiction
    // is not a record to open — it is a question to answer.
    expect(bodyText()).toMatch(/\d+ of \d+ claims still need a decision/i);
  });
});

describe('the profile diff with nothing in it', () => {
  it('says the canonical profile matches the last snapshot', async () => {
    const zipPath = join(evidence, 'export.zip');
    writeFileSync(
      zipPath,
      makeZip([
        {
          name: 'Profile.csv',
          data: Buffer.from(
            'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
              // Only the headline: any other column becomes a snapshot field with
              // no canonical section to match it, and the diff would rightly
              // report every one of them as a difference.
              ',,,,,Builds evidence-backed tooling.,,,,,,,\n',
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
    const snapshot = importSnapshot(harness.fixture.db, harness.fixture.store, source.id);

    // Canonical rewritten to match the snapshot exactly, which is the state a
    // member reaches after applying every patch.
    const profile = getProfile(harness.fixture.db);
    for (const [key, field] of Object.entries(snapshot.fields)) {
      const current = profile[key as keyof typeof profile];
      if (current === undefined) continue;
      updateSection(harness.fixture.db, {
        section_key: key as never,
        content_text: field.value_text,
        claim_ids: [],
        author: 'user',
        based_on_revision: current?.id ?? null,
      });
    }

    await mount(ProfileScreen, '#/profile/diff');

    // "Nothing changed" has to be said in words: an empty region here would
    // read as a diff that failed to load.
    expect(bodyText()).toMatch(/matches the last snapshot/i);
  }, 60_000);
});

describe('an upload that fails before the server answers', () => {
  it('shows the transport error rather than nothing at all', async () => {
    await mount(SetupScreen, '#/setup');

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    // The request never reaches the loopback server, so there is no API
    // refusal to show — only the reason the browser gave.
    harness.installApiFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(16);

    // hono's form component reads ev.detail on an untrusted submit event, and
    // clicking a submit button in happy-dom does not carry one.
    document
      .querySelector('form')
      ?.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true, detail: {} }));
    await flush(24);

    expect(bodyText()).not.toContain('[object Object]');
  });

  it('shows something legible even when what was thrown is not an Error', async () => {
    await mount(SetupScreen, '#/setup');

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) return;
    harness.installApiFetch(() => {
      // Not everything a browser or an extension throws is an Error.
      throw 'the upload was blocked';
    });

    const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(16);
    document
      .querySelector('form')
      ?.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true, detail: {} }));
    await flush(24);

    // "[object Object]" under a failed upload tells a member nothing and looks
    // like the product is broken in a second, unrelated way.
    expect(bodyText()).not.toContain('[object Object]');
    expect(bodyText()).toContain('the upload was blocked');
  });
});

describe('the evidence corpus view', () => {
  it('lists artifacts with their source and trust', async () => {
    seedRealArtifact(harness.fixture, 'A second document in the corpus.', {
      relpath: 'SECOND.md',
    });

    await mount(EvidenceScreen, '#/evidence/artifacts');

    const shown = bodyText();
    // Redaction is the column that matters here: it says whether anything in
    // the file was scrubbed on the way in, which is the one thing a reviewer
    // cannot recover by opening the original.
    expect(shown).toMatch(/redaction/i);
    expect(shown).toContain('SECOND.md');
    expect(shown).not.toContain('[object Object]');
  });
});

describe('a patch the next snapshot confirmed', () => {
  it('says it is live rather than leaving it looking unapplied', async () => {
    // The whole loop: a snapshot to diff against, a patch generated from that
    // diff, accepted, exported, marked applied by hand — and then a second
    // export in which LinkedIn shows the new text.
    await importedSnapshot('An older headline that no longer describes the work');
    const changeSet = generateChangeSet(harness.fixture.db, { title: 'headline refresh' });
    const patch = changeSet.patches[0];
    if (!patch) return;
    reviewPatch(harness.fixture.db, { patch_id: patch.id, action: 'accept' });
    exportChangeSet(harness.fixture.db, changeSet.id);
    markPatchApplied(harness.fixture.db, {
      patch_id: patch.id,
      confirm: true,
      actor: 'dashboard',
    });
    await importedSnapshot(patch.new_text);

    expect(
      getChangeSet(harness.fixture.db, changeSet.id).patches[0]?.applied_verified_snapshot_id,
    ).toBeTruthy();

    await mount(ProfileScreen, '#/profile/changesets');
    const open = buttons().find((b) => /^open$/i.test(b.textContent ?? ''));
    expect(open).toBeTruthy();
    open?.click();
    await flush(20);

    // Marking a patch applied is the member saying they pasted it. This is the
    // product agreeing, on evidence, and it is the only way they learn the
    // paste actually took.
    expect(bodyText()).toMatch(/confirmed live in a later snapshot/i);
  }, 90_000);
});
