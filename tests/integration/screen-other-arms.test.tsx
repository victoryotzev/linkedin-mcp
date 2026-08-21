// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import type { FC } from 'hono/jsx/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureLane,
  enablePublishing,
  proposeClaim,
  verifyClaim,
  verifyLane,
  writeDraft,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { ContentScreen } from '../../linkedin-dashboard/src/client/screens/Content.tsx';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { PublishingScreen } from '../../linkedin-dashboard/src/client/screens/Publishing.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The same screens with the condition the other way round.
//
// Every one of these is a place where the interesting state is the absence of
// something: a capability with no blockers left, a readiness list with nothing
// to remediate, an opportunity nothing prior resembles, a sentence nothing
// supports. Each is easy to get wrong in a way that only shows on a healthy
// machine, which is the machine the member will have most of the time.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;
let secrets: SecretStore;

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    async put(name, value) {
      values.set(name, value);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    has(name) {
      return values.has(name);
    },
    listNames() {
      return [...values.keys()].sort();
    },
    async remove(name) {
      values.delete(name);
    },
  };
}

function seed(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  secrets = memorySecrets();
  harness = createClientHarness('screen-other-arms', seed, { secretStore: secrets });
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

const bodyText = () => document.body.textContent ?? '';
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));

async function click(pattern: RegExp): Promise<boolean> {
  const button = buttons().find((b) => pattern.test(b.textContent ?? ''));
  if (!button || button.disabled) return false;
  button.click();
  await flush(16);
  return true;
}

async function openPublishing(): Promise<void> {
  await configureLane(harness.fixture.db, secrets, {
    lane: 'write',
    client_id: 'cid-write',
    access_token: TOKEN,
  });
  await verifyLane(
    harness.fixture.db,
    secrets,
    'write',
    async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
    'dashboard',
  );
  enablePublishing(harness.fixture.db, true, 'dashboard');
}

describe('publishing readiness with nothing left to fix', () => {
  it('shows no remediation line at all', async () => {
    await openPublishing();

    await mount(PublishingScreen, '#/publishing/readiness');

    const shown = bodyText();
    // A remediation paragraph under a green list would read as though something
    // were still wrong, which is the one thing a readiness screen must not do.
    expect(shown).toMatch(/ready/i);
    expect(shown).not.toMatch(/developer app|token generator/i);
  });
});

describe('the overview readiness list with a capability that is clear', () => {
  it('shows no blockers line for it', async () => {
    await openPublishing();

    await mount(OverviewScreen, '#/overview/readiness');

    // "blockers:" with nothing after it is worse than no line: it invites the
    // reader to look for something that is not there.
    expect(bodyText()).not.toMatch(/blockers:\s*(?:$|[A-Z])/m);
    expect(bodyText()).not.toContain('[object Object]');
  });
});

describe('an opportunity nothing prior resembles', () => {
  it('says nothing about a closest prior rather than naming an empty one', async () => {
    const { artifactId } = seedRealArtifact(
      harness.fixture,
      'The vault wraps its master key with Windows DPAPI under the current user.',
      { relpath: 'VAULT.md' },
    );
    const claim = proposeClaim(harness.fixture.db, {
      statement: 'The credential vault wraps its master key with Windows DPAPI.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(harness.fixture.db, {
      claim_id: claim.id,
      confirm: true,
      reviewer: 'user:test',
    });

    await mount(ContentScreen, '#/content/opportunities');

    const shown = bodyText();
    // Nothing has been published and no draft covers this, so there is no prior
    // to compare against. Printing an empty "closest prior:" would suggest one.
    expect(shown).toMatch(/novelty/i);
    expect(shown).not.toMatch(/closest prior:\s*·/);
    expect(shown).not.toContain('[object Object]');
  }, 60_000);
});

describe('a sentence nothing supports at all', () => {
  it('is toned as unsupported rather than merely partial', async () => {
    writeDraft(harness.fixture.db, {
      draft_id: seeded.draftId,
      body_text:
        'The project contains 181 test files. ' +
        // Five of fifteen significant tokens overlap the verified claim, which
        // lands between the partial and supported thresholds.
        'The project contains 181 test files across every workspace package, ' +
        'alongside documentation, tooling, examples and continuous integration. ' +
        'Quantum ferrets rearranged my furniture overnight.',
    });

    await mount(ContentScreen, '#/content/drafts');
    expect(await click(/^open$/i)).toBe(true);
    expect(await click(/^coverage$/i)).toBe(true);
    expect(await click(/check coverage/i)).toBe(true);

    // Read off the chips rather than the page: "unsupported sentences" appears
    // in the screen's own hint text, which would pass without the tone ever
    // being computed.
    const chips = Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent ?? '');
    // Three tones, not two. A sentence with no overlap at all is a different
    // problem from one that is half-covered, and the fix is different too: one
    // needs evidence, the other needs the sentence narrowed to what the
    // evidence already says.
    expect(chips.some((c) => /^.?supported$/i.test(c))).toBe(true);
    expect(chips.some((c) => /partial/i.test(c))).toBe(true);
    expect(chips.some((c) => /unsupported/i.test(c))).toBe(true);
    expect(bodyText()).toMatch(/ferrets/i);
  });
});
