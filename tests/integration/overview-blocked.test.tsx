// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLane, grantApproval, type SecretStore } from '@linkedin-mcp/domain';
import { OverviewScreen } from '../../linkedin-dashboard/src/client/screens/Overview.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The Overview's two halves: what to do next, and what cannot proceed.
//
// The blocked section is the one a member reads when nothing is working, so it
// has to say what is in the way rather than that something is. It carries the
// domain's own remediation text verbatim — some of the clearest writing in the
// product — and it distinguishes a chain nobody has checked from one that is
// fine, because unknown and healthy must not look alike.

let harness: ClientHarness;
let seeded: ReturnType<typeof seedHealthy>;
let container: HTMLElement;
let root: Root | null = null;

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

function seedWith(fixture: Fixture): void {
  seeded = seedHealthy(fixture);
}

beforeEach(() => {
  harness = createClientHarness('overview-blocked', seedWith);
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

async function mount(): Promise<void> {
  location.hash = '#/overview';
  root = createRoot(container);
  root.render(<OverviewScreen />);
  await flush(16);
}

const bodyText = () => document.body.textContent ?? '';
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));

describe('the blocked section', () => {
  it('names each unusable capability and carries its remediation verbatim', async () => {
    await mount();

    const shown = bodyText();
    expect(shown).toMatch(/blocked/i);
    // Not "something is wrong": the specific capability, its blockers, and the
    // domain's own sentence about what to do.
    expect(shown).toMatch(/linkedin\./);
    expect(shown).toMatch(/blockers:/i);
    expect(shown).toMatch(/developer portal|token generator|EEA|Switzerland/i);
  });

  it('warns about a token that expires soon, before it does', async () => {
    await configureLane(harness.fixture.db, memorySecrets(), {
      lane: 'read',
      client_id: 'cid-read',
      access_token: 'AQV-fake-fixture-token-not-a-real-credential-0123456789',
      expires_in_seconds: 3 * 24 * 60 * 60,
    });

    await mount();

    // A lane that dies quietly mid-week is worse than one that never worked;
    // the warning comes while there is still time to mint a fresh token.
    const shown = bodyText();
    expect(shown).toMatch(/expires/i);
    expect(shown).toMatch(/mint a fresh token/i);
  });

  it('says nothing about a token with plenty of time left', async () => {
    await configureLane(harness.fixture.db, memorySecrets(), {
      lane: 'read',
      client_id: 'cid-read',
      access_token: 'AQV-fake-fixture-token-not-a-real-credential-0123456789',
      expires_in_seconds: 365 * 24 * 60 * 60,
    });

    await mount();

    expect(bodyText()).not.toMatch(/lane token expires/i);
  });
});

describe('the audit chain line', () => {
  it('reports an intact chain with its length and head', async () => {
    await mount();

    const shown = bodyText();
    expect(shown).toMatch(/audit chain/i);
    expect(shown).toMatch(/intact/i);
    expect(shown).toMatch(/\d+ events/);
  });

  it('never shows an unchecked chain as fine', async () => {
    // The chain is fetched separately, so there is a moment where it is not
    // known. Rendering that as "intact" or as zero events would be a claim
    // nothing has established.
    harness.installApiFetch((path) =>
      path.includes('/system/chain') ? (new Promise(() => {}) as never) : null,
    );

    await mount();

    expect(bodyText()).not.toMatch(/intact/i);
    expect(bodyText()).toMatch(/checking/i);
  });
});

describe('the work queue rows', () => {
  it('names an armed approval by the revision it authorises', async () => {
    grantApproval(harness.fixture.db, seeded.approvalId, 'dashboard');

    await mount();

    const shown = bodyText();
    expect(shown).toMatch(/approval is armed/i);
    // The revision hash is what makes it specific: an armed approval is bound
    // to exactly one text.
    expect(shown).toMatch(/live single-use authorisation/i);
    expect(shown).toMatch(/[a-f0-9]{12}/);
  });

  it('sends each row to the screen that resolves it', async () => {
    await mount();
    const openButtons = buttons().filter((b) => /^open$/i.test(b.textContent ?? ''));
    expect(openButtons.length).toBeGreaterThan(0);

    openButtons[0]?.click();
    await flush(10);

    // A row that names a problem without offering the screen that fixes it is
    // worse than not naming it.
    expect(location.hash).toMatch(/^#\/(evidence|profile|content|publishing|system)/);
  });

  it('drives every row through to its destination without a render error', async () => {
    await mount();
    const total = buttons().filter((b) => /^open$/i.test(b.textContent ?? '')).length;

    for (let index = 0; index < total; index += 1) {
      root?.unmount();
      await mount();
      buttons()
        .filter((b) => /^open$/i.test(b.textContent ?? ''))
        [index]?.click();
      await flush(10);
      expect(location.hash.length).toBeGreaterThan(1);
      expect(bodyText()).not.toContain('[object Object]');
    }
  });
});
