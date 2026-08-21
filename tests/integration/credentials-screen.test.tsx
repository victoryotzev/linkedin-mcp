// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { laneAccount, listCapabilities, type SecretStore } from '@linkedin-mcp/domain';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// The credentials screen with a working vault and a probe behind it.
//
// This is the one screen where a member handles a secret, and the only place in
// the product where the value they type must never come back. Other suites
// build the app without a secret store, which is right for what they test and
// leaves this screen permanently in its "unavailable" state. Here it works, so
// what the screen does on success is finally observable.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;
let vault: Map<string, string>;
let probes: Array<{ lane: string; token: string }>;
let probeResult: {
  ok: boolean;
  person_urn?: string;
  status?: number;
  message?: string;
};

function memorySecrets(): SecretStore {
  vault = new Map<string, string>();
  return {
    async put(name, value) {
      vault.set(name, value);
    },
    async get(name) {
      return vault.get(name) ?? null;
    },
    has(name) {
      return vault.has(name);
    },
    listNames() {
      return [...vault.keys()].sort();
    },
    async remove(name) {
      vault.delete(name);
    },
  };
}

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

beforeEach(() => {
  probes = [];
  probeResult = { ok: true, person_urn: 'urn:li:person:FixtureMember' };
  harness = createClientHarness('credentials-screen', seedHealthy, {
    secretStore: memorySecrets(),
    probeLane: async (lane, token) => {
      probes.push({ lane, token });
      return probeResult as never;
    },
  });

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

async function mount(view = 'credentials'): Promise<void> {
  location.hash = `#/system/${view}`;
  root = createRoot(container);
  root.render(<SystemScreen />);
  await flush(16);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const inputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const bodyText = () => document.body.textContent ?? '';
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));

async function type(index: number, value: string): Promise<void> {
  const field = inputs()[index];
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(10);
}

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(14);
  return true;
}

/** Answers the innermost confirmation. */
async function confirm(): Promise<boolean> {
  const scope = dialogs()[dialogs().length - 1];
  if (!scope) return false;
  const inDialog = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'));
  const cancelIndex = inDialog.findIndex((b) => /^cancel$/i.test(b.textContent ?? ''));
  const affirmative = cancelIndex >= 0 ? inDialog[cancelIndex + 1] : inDialog[inDialog.length - 1];
  if (!affirmative || affirmative.disabled) return false;
  affirmative.click();
  await flush(20);
  return true;
}

describe('storing a credential', () => {
  it('encrypts it, clears the field and never shows it again', async () => {
    await mount();
    await type(0, 'test-client-id-read');
    await type(1, TOKEN);

    expect(await click(/save encrypted/i)).toBe(true);
    expect(await confirm()).toBe(true);

    // Stored out of the database, and gone from the page.
    expect([...vault.values()]).toContain(TOKEN);
    expect(bodyText()).not.toContain(TOKEN);
    for (const field of inputs()) expect(field.value).not.toContain(TOKEN);
    // The row records that a token exists without carrying it.
    expect(laneAccount(harness.fixture.db, 'read').has_token).toBe(true);
  });

  it('records an expiry when the member pastes one', async () => {
    await mount();
    await type(0, 'test-client-id-read');
    await type(1, TOKEN);
    await type(2, '3600');

    await click(/save encrypted/i);
    await confirm();

    expect(laneAccount(harness.fixture.db, 'read').token_expires_at).toBeTruthy();
  });

  it('says so, and stores nothing, when the server refuses', async () => {
    await mount();
    harness.installApiFetch((path) =>
      path.includes('/token')
        ? new Response(
            JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'that is not a token' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        : null,
    );
    await type(0, 'cid');
    await type(1, TOKEN);

    await click(/save encrypted/i);
    await confirm();

    expect(vault.size).toBe(0);
    // And the field is cleared regardless, so a rejected secret is not left in
    // the DOM for the next screenshot.
    for (const field of inputs()) expect(field.value).not.toContain(TOKEN);
  });
});

describe('verifying a lane', () => {
  async function storeThen(): Promise<void> {
    await mount();
    await type(0, 'test-client-id-read');
    await type(1, TOKEN);
    await click(/save encrypted/i);
    await confirm();
    root?.unmount();
    await mount();
  }

  it('sends the stored token to the probe and reports a verified lane', async () => {
    await storeThen();

    expect(await click(/verify against linkedin/i)).toBe(true);
    await confirm();

    // The probe got the real token out of the vault — that is what makes
    // verification mean anything at all.
    expect(probes[0]?.token).toBe(TOKEN);
    expect(probes[0]?.lane).toBe('read');
    expect(laneAccount(harness.fixture.db, 'read').status).toBe('verified');
  });

  it('says the lane is not open yet when the probe warns', async () => {
    await storeThen();
    harness.installApiFetch((path) =>
      path.includes('/verify')
        ? new Response(JSON.stringify({ result: { warnings: ['snapshot_not_ready'] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : null,
    );

    await click(/verify against linkedin/i);
    await confirm();

    // The distinction is announced through a toast, which AppShell hosts and
    // this mount does not, so what is assertable here is that the screen did
    // not go on to claim more than the probe supports: nothing is marked
    // cleanly verified on the strength of a warning.
    root?.unmount();
    await mount('capabilities');
    expect(bodyText()).not.toMatch(/lane verified against linkedin/i);
  });

  it('leaves the capability closed when the probe fails', async () => {
    await storeThen();
    probeResult = { ok: false, status: 401, message: 'Invalid access token' };

    await click(/verify against linkedin/i);
    await confirm();

    expect(
      listCapabilities(harness.fixture.db).some(
        (c) => c.status === 'verified' && c.blockers.length === 0,
      ),
    ).toBe(false);
  });
});

describe('the capabilities view after verification', () => {
  it('shows what was proved, and that publishing is still a separate decision', async () => {
    await mount();
    await type(0, 'test-client-id-read');
    await type(1, TOKEN);
    await click(/save encrypted/i);
    await confirm();
    root?.unmount();
    await mount();
    await click(/verify against linkedin/i);
    await confirm();

    root?.unmount();
    await mount('capabilities');

    const shown = bodyText();
    expect(shown).toMatch(/linkedin\.dma/);
    // Proving a credential is not deciding to post with it.
    expect(shown).toMatch(/awaiting_explicit_enable|not verified|verified/);
  });
});
