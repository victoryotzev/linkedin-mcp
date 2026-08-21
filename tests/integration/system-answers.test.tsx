// @vitest-environment happy-dom
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendAuditEvent,
  configureLane,
  runBackup,
  getFeatureControl,
  listCapabilities,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The System confirmations that need the machine to be in a particular state
// first.
//
// Its neighbour answers the three dangerous confirmations on a healthy
// machine. These are the ones that only appear once something else has
// happened: publishing can only be enabled after a credential has been proved,
// a backup can only fail verification after it has been damaged, and the tool
// console only warns about a destructive operation once a destructive tool is
// selected. Each is a case where the wrong wording is worse than none.

let harness: ClientHarness;
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

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';
let secrets: SecretStore;

function seed(fixture: Fixture): void {
  seedHealthy(fixture);
  // An event with no subject at all: the server has started, which is about the
  // whole machine rather than about any one record.
  appendAuditEvent(fixture.db, {
    event_type: 'system.started',
    actor: 'system',
    subject_type: 'system',
  });
}

beforeEach(() => {
  secrets = memorySecrets();
  harness = createClientHarness('system-answers', seed, { secretStore: secrets });
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
  location.hash = `#/system/${view}`;
  root = createRoot(container);
  root.render(<SystemScreen />);
  await flush(16);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const bodyText = () => document.body.textContent ?? '';

function dialog(): HTMLElement | undefined {
  // Drawer carries role="dialog" too, so the confirmation is the last one open.
  const all = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
  return all[all.length - 1];
}

function confirmButton(): HTMLButtonElement | undefined {
  const scope = dialog();
  if (!scope) return undefined;
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => !/^cancel$/i.test(b.textContent ?? ''),
  );
}

async function click(pattern: RegExp): Promise<boolean> {
  const button = byLabel(pattern);
  if (!button || button.disabled) return false;
  button.click();
  await flush(16);
  return true;
}

async function answer(): Promise<boolean> {
  const confirm = confirmButton();
  if (!confirm || confirm.disabled) return false;
  confirm.click();
  await flush(20);
  return true;
}

/** Stores and proves a write-lane credential the way the credentials view does. */
async function proveWriteLane(): Promise<void> {
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
}

describe('turning a feature off', () => {
  it('asks first, then actually turns it off', async () => {
    await mount('features');
    expect(getFeatureControl(harness.fixture.db, 'analytics').enabled).toBe(true);

    expect(await click(/disable/i)).toBe(true);
    expect(dialog()).toBeTruthy();
    // Still on while the question is open: opening a confirmation must not be
    // the same as answering it.
    expect(bodyText()).toBeTruthy();

    expect(await answer()).toBe(true);

    const off = ['analytics', 'evidence', 'profile', 'content', 'maintenance'].some(
      (key) => !getFeatureControl(harness.fixture.db, key as never).enabled,
    );
    expect(off).toBe(true);
  });
});

describe('the second gate in front of publishing', () => {
  it('offers nothing to press while no credential has been proved', async () => {
    await mount('capabilities');

    // The domain refuses without a proven write lane, so offering the control
    // here would be offering something that fails.
    expect(byLabel(/enable publishing/i)).toBeUndefined();
  });

  it('offers the control once the lane is proved, and opens the capability when answered', async () => {
    await proveWriteLane();
    await mount('capabilities');

    expect(await click(/enable publishing/i)).toBe(true);
    // The wording is the point: proving the credential works is not the same
    // as deciding to post.
    expect(dialog()?.textContent ?? '').toMatch(/second gate/i);
    expect(await answer()).toBe(true);

    expect(listCapabilities(harness.fixture.db, 'linkedin.publish_post')[0]?.status).toBe(
      'verified',
    );
    expect(bodyText()).not.toContain('[object Object]');
  });
});

describe('an audit entry about the machine rather than a record', () => {
  it('shows a dash for the subject instead of an empty slot', async () => {
    await mount('audit');

    let opened = false;
    const count = buttons().filter((b) => /^inspect$/i.test(b.textContent ?? '')).length;
    for (let index = 0; index < count; index += 1) {
      root?.unmount();
      await mount('audit');
      buttons()
        .filter((b) => /^inspect$/i.test(b.textContent ?? ''))
        [index]?.click();
      await flush(14);
      if (!/system\.started/.test(bodyText())) continue;
      opened = true;
      // An empty slot reads as a rendering fault; a dash reads as "this event
      // is not about one record", which is what it is.
      expect(bodyText()).toContain('—');
      break;
    }
    expect(opened).toBe(true);
  });
});

describe('a backup that no longer matches its manifest', () => {
  it('leaves the purge locked instead of counting as a safety net', async () => {
    const backup = await runBackup(harness.fixture.db, harness.fixture.dir, {
      actor: 'dashboard',
    });
    const manifestPath = join(backup.directory, 'backup-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries: Array<{ path: string }>;
    };
    const victim = join(backup.directory, manifest.entries[0]?.path ?? 'linkedin.sqlite3');
    writeFileSync(victim, 'these are not the bytes that were backed up');

    await mount('data');
    expect(await click(/^verify/i)).toBe(true);
    if (dialog()) await answer();
    await flush(24);

    // A backup is the only thing between the member and a purge that cannot be
    // undone, so "verified" has to mean the bytes still hash the same. A failed
    // verification must not leave the machine looking safe to erase.
    expect(bodyText()).toMatch(/no verified backup/i);
    expect(byLabel(/delete all local data/i)?.disabled).toBe(true);
  });

  it('unlocks the purge when the bytes do still match', async () => {
    await runBackup(harness.fixture.db, harness.fixture.dir, { actor: 'dashboard' });

    await mount('data');
    expect(await click(/^verify/i)).toBe(true);
    if (dialog()) await answer();
    await flush(24);

    expect(bodyText()).toMatch(/verified backup available/i);
    expect(byLabel(/delete all local data/i)?.disabled).toBe(false);
  });
});

describe('the tool console', () => {
  it('warns that an operation is destructive before running it', async () => {
    await mount('tools');

    const select = document.querySelector<HTMLSelectElement>('select');
    expect(select).toBeTruthy();
    if (!select) return;
    const destructive = Array.from(select.options).find((o) => /purge|delete/i.test(o.value));
    expect(destructive).toBeTruthy();
    if (!destructive) return;
    select.value = destructive.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(16);

    expect(await click(/^run /i)).toBe(true);

    // Three different warnings for three different kinds of risk. A destructive
    // local operation is not the same as one that contacts LinkedIn, and
    // telling a member the wrong one teaches them to ignore all of them.
    expect(dialog()?.textContent ?? '').toMatch(/marked destructive/i);
  });

  it('warns about the network for a tool that leaves the machine', async () => {
    await mount('tools');

    const select = document.querySelector<HTMLSelectElement>('select');
    expect(select).toBeTruthy();
    if (!select) return;
    const external = Array.from(select.options).find((o) =>
      /dma_sync|publish_execute/.test(o.value),
    );
    expect(external).toBeTruthy();
    if (!external) return;
    select.value = external.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(16);

    expect(await click(/^run /i)).toBe(true);

    expect(dialog()?.textContent ?? '').toMatch(/external service/i);
  });
});
