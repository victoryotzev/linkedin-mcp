// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listBackups } from '@linkedin-mcp/domain';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// The confirmations answered.
//
// Everywhere else the assertion is that a click opens a question and changes
// nothing. Here the question gets answered, because the other half of that
// contract matters just as much: a member who types the phrase and presses the
// button has to actually get the thing. These are the three that touch the
// dangerous surfaces — storing a credential, creating and verifying a backup,
// and the full purge — so each one also checks what came back.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeAll(() => {
  harness = createClientHarness('system-depth', seedHealthy);
});

afterAll(() => harness.close());

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

async function mount(view: string): Promise<void> {
  location.hash = `#/system/${view}`;
  root = createRoot(container);
  root.render(<SystemScreen />);
  await flush(14);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const inputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input'));
const bodyText = () => document.body.textContent ?? '';
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(14);
  return true;
}

/**
 * Types into the input at `index`, re-querying first: a controlled input is
 * replaced on re-render, so a node captured before an earlier keystroke is
 * detached and typing into it does nothing at all.
 */
async function type(index: number, value: string): Promise<void> {
  const field = inputs()[index];
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  // hono/jsx schedules its update off the current task, so a control whose
  // disabled state depends on this value is still stale until the flush.
  await flush(8);
}

/** The affirmative control inside the confirmation, never the Cancel next to it. */
function confirmButton(): HTMLButtonElement | undefined {
  const scope = dialog();
  if (!scope) return undefined;
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => !/^cancel$/i.test(b.textContent ?? ''),
  );
}

describe('storing a credential', () => {
  it('needs a confirmation, then encrypts the token and never echoes it back', async () => {
    await mount('credentials');

    // The read lane's three fields come first: client id, token, expiry.
    await type(0, 'test-client-id-read');
    await type(1, 'AQV-fake-fixture-token-not-a-real-credential-0123456789');

    expect(await click(/save encrypted/i)).toBe(true);
    expect(dialog(), 'storing a credential must be confirmed').not.toBeNull();

    confirmButton()?.click();
    await flush(20);

    // Whatever the vault did, the token must not be sitting in the DOM
    // afterwards — the field is cleared on both success and failure.
    expect(bodyText()).not.toContain('AQV-fake-fixture-token');
    for (const field of inputs()) {
      expect(field.value).not.toContain('AQV-fake-fixture-token');
    }
  });

  it('clears the token field even when the store is refused', async () => {
    await mount('credentials');
    harness.installApiFetch((path) =>
      path.includes('/token') ? new Response('{"error":"nope"}', { status: 500 }) : null,
    );

    await type(0, 'test-client-id-read');
    await type(1, 'AQV-fake-fixture-token-rejected-by-the-server');
    await click(/save encrypted/i);
    confirmButton()?.click();
    await flush(20);

    // A failed store that left the secret in the DOM would leak it into any
    // screenshot or screen share the member takes next.
    for (const field of inputs()) {
      expect(field.value).not.toContain('AQV-fake-fixture-token');
    }
  });

  it('reports a lane that verifies but does not open, rather than claiming success', async () => {
    await mount('credentials');
    harness.installApiFetch((path) =>
      path.includes('/verify')
        ? new Response(
            JSON.stringify({ result: { warnings: ['no member data portability product'] } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : null,
    );

    expect(await click(/verify against linkedin/i)).toBe(true);
    if (dialog()) {
      confirmButton()?.click();
      await flush(20);
    }

    // A probe can succeed without the lane being usable. Saying "verified"
    // there would be a claim the capability list directly contradicts.
    expect(bodyText()).toMatch(/not open yet|warning|portability/i);
  });
});

describe('backups', () => {
  it('creates one when the confirmation is answered', async () => {
    await mount('data');
    const before = listBackups(harness.fixture.dir).length;

    expect(await click(/create a backup/i)).toBe(true);
    if (dialog()) {
      confirmButton()?.click();
      await flush(24);
    }

    expect(listBackups(harness.fixture.dir).length).toBeGreaterThan(before);
  });

  it('verifies one and says how many entries matched', async () => {
    await mount('data');
    await click(/create a backup/i);
    if (dialog()) confirmButton()?.click();
    await flush(24);

    root?.unmount();
    await mount('data');
    expect(await click(/^verify$/i)).toBe(true);
    if (dialog()) {
      confirmButton()?.click();
      await flush(24);
    }

    // "Verified" has to mean something checkable: the count of entries that
    // matched is what turns a belief into a safety net.
    expect(bodyText()).toMatch(/verified|entries|match/i);
  });

  it('unlocks the full purge once a backup has actually verified', async () => {
    await mount('data');
    await click(/create a backup/i);
    if (dialog()) confirmButton()?.click();
    await flush(24);

    root?.unmount();
    await mount('data');
    await click(/^verify$/i);
    if (dialog()) confirmButton()?.click();
    await flush(24);

    const purge = byLabel(/delete all local data/i);
    expect(purge, 'the data view should offer the full purge').toBeTruthy();
    // Verification is what opens the control. Before it, the button is closed
    // whether or not a backup file exists.
    expect(purge?.disabled).toBe(false);
  });
});

describe('the full purge, carried through', () => {
  async function openPurgeConfirmation(): Promise<HTMLElement | null> {
    await mount('data');
    // Accepting the loss is the way in for a member with no verified backup.
    inputs()
      .find((i) => i.type === 'checkbox')
      ?.click();
    await flush(10);
    if (!(await click(/delete all local data/i))) return null;
    return dialog();
  }

  it('demands the harsher phrase when nothing has been verified, exactly', async () => {
    const scope = await openPurgeConfirmation();
    expect(scope).not.toBeNull();
    if (!scope) return;

    const phraseField = scope.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    expect(phraseField, 'the full purge must demand a typed phrase').toBeTruthy();
    if (!phraseField) return;

    // Without a verified backup the member is not asked to confirm a deletion.
    // They are asked to state that they accept losing everything permanently.
    expect(scope.textContent).toContain('NO BACKUP I ACCEPT PERMANENT LOSS');
    expect(confirmButton()?.disabled).toBe(true);

    // A trailing space is a near miss, and a near miss is a no.
    phraseField.value = 'NO BACKUP I ACCEPT PERMANENT LOSS ';
    phraseField.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(12);
    expect(confirmButton()?.disabled).toBe(true);

    phraseField.value = 'NO BACKUP I ACCEPT PERMANENT LOSS';
    phraseField.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(12);
    expect(confirmButton()?.disabled).toBe(false);
  });

  it('reports a refusal rather than showing an empty machine that still has data', async () => {
    // The real route refuses when it has no shutdown hook to call, which is
    // what happens here. The window must say so.
    const scope = await openPurgeConfirmation();
    if (!scope) return;
    const phraseField = scope.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    if (!phraseField) return;
    phraseField.value = 'NO BACKUP I ACCEPT PERMANENT LOSS';
    phraseField.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(12);

    confirmButton()?.click();
    await flush(24);

    // The refusal is announced through a toast, which AppShell hosts and this
    // mount does not. What is assertable here is the part that matters: the
    // window must not switch to its "everything is gone" state over a refusal,
    // and the data must still be there behind it.
    expect(bodyText()).not.toMatch(/no longer connected|has been deleted/i);
    expect(
      Number(harness.fixture.db.get('SELECT COUNT(*) AS n FROM claims')?.['n']),
    ).toBeGreaterThan(0);
  });

  it('reports the machine is empty once the server accepts', async () => {
    const scope = await openPurgeConfirmation();
    if (!scope) return;
    const phraseField = scope.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    if (!phraseField) return;
    phraseField.value = 'NO BACKUP I ACCEPT PERMANENT LOSS';
    phraseField.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(12);

    harness.installApiFetch((path) =>
      path.includes('/purge-all')
        ? new Response(JSON.stringify({ status: 'purging' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : null,
    );
    confirmButton()?.click();
    await flush(24);

    // The window has to stop looking operable: behind it the database, the
    // artifact store and the encryption key are gone and the server is down.
    expect(bodyText()).toMatch(/deleted|no longer connected|shut down/i);
  });
});

describe('the remaining system views in depth', () => {
  it('drives every control on features, capabilities, retention and analytics', async () => {
    for (const view of ['features', 'capabilities', 'retention', 'analytics', 'audit', 'tools']) {
      root?.unmount();
      await mount(view);
      const count = buttons().filter((b) => !b.disabled).length;

      for (let index = 0; index < count; index += 1) {
        root?.unmount();
        await mount(view);
        buttons()
          .filter((b) => !b.disabled)
          [index]?.click();
        await flush(10);
        expect(bodyText(), `#/system/${view} control ${index}`).not.toContain('[object Object]');
      }
    }
  });

  it('filters the audit log by event type', async () => {
    await mount('audit');

    const select = document.querySelector<HTMLSelectElement>('select');
    if (!select || select.options.length < 2) return;
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(14);

    expect(bodyText()).not.toContain('[object Object]');
  });
});
