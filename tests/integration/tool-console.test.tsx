// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listClaims } from '@linkedin-mcp/domain';
import { SystemScreen } from '../../linkedin-dashboard/src/client/screens/System.tsx';
import { createClientHarness, flush, type ClientHarness } from '../helpers/clientHarness.ts';
import { seedHealthy } from '../helpers/fixtures.ts';

// The advanced console: the dashboard's own window onto the MCP registry.
//
// It exists so a member can see exactly what a model can do on their behalf and
// run any of it themselves. That makes it the one screen where the safety
// argument is inverted — it is a general-purpose tool runner sitting behind the
// session cookie — so what matters is that it reads the same registry the MCP
// server exposes and that a tool which is not plainly read-only stops for a
// confirmation before it runs.

let harness: ClientHarness;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  harness = createClientHarness('tool-console', seedHealthy);
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
  location.hash = '#/system/tools';
  root = createRoot(container);
  root.render(<SystemScreen />);
  await flush(16);
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const byLabel = (pattern: RegExp) => buttons().find((b) => pattern.test(b.textContent ?? ''));
const select = () => document.querySelector<HTMLSelectElement>('select');
const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea');
const bodyText = () => document.body.textContent ?? '';
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function choose(name: string): Promise<void> {
  const control = select();
  if (!control) return;
  control.value = name;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  await flush(12);
}

async function type(value: string): Promise<void> {
  const box = textarea();
  if (!box) return;
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(12);
}

async function run(): Promise<boolean> {
  const button = byLabel(/^run|execute/i);
  if (!button || button.disabled) return false;
  button.click();
  await flush(16);
  return true;
}

async function confirm(): Promise<boolean> {
  const scope = dialog();
  if (!scope) return false;
  const inDialog = Array.from(scope.querySelectorAll<HTMLButtonElement>('button'));
  const cancelIndex = inDialog.findIndex((b) => /^cancel$/i.test(b.textContent ?? ''));
  const affirmative = cancelIndex >= 0 ? inDialog[cancelIndex + 1] : inDialog[inDialog.length - 1];
  if (!affirmative || affirmative.disabled) return false;
  affirmative.click();
  await flush(20);
  return true;
}

describe('the catalog', () => {
  it('lists the real registry, with the permission tier of each tool', async () => {
    await mount();

    const shown = bodyText();
    expect(shown).toMatch(/linkedin_claim_list/);
    // The tier is how a member reads what a tool can reach without opening it.
    expect(shown).toMatch(/local-read|local-write|external/);
  });

  it('offers every tool in the registry, not a hand-maintained subset', async () => {
    await mount();

    const options = Array.from(select()?.options ?? []).map((o) => o.value);
    expect(options.length).toBeGreaterThan(30);
    expect(options).toContain('linkedin_publish_execute');
    expect(options).toContain('linkedin_purge_run');
  });
});

describe('running a read-only tool', () => {
  it('runs it straight away and shows the result', async () => {
    await mount();
    await choose('linkedin_claim_list');
    await type('{}');

    expect(await run()).toBe(true);

    // A read that changes nothing does not need a confirmation in front of it;
    // asking would train the member to click through the ones that matter.
    expect(dialog()).toBeNull();
    expect(bodyText()).toMatch(/clm_|items/);
  });

  it('refuses input that is not JSON, and says why before sending anything', async () => {
    await mount();
    await choose('linkedin_claim_list');
    await type('{ this is not json');

    await run();

    expect(bodyText()).toMatch(/invalid json/i);
    // Nothing was sent: the parse failure is local.
    expect(bodyText()).not.toMatch(/clm_/);
  });

  it('clears the form when a different tool is chosen', async () => {
    await mount();
    await choose('linkedin_claim_list');
    await type('{ broken');
    await run();
    expect(bodyText()).toMatch(/invalid json/i);

    await choose('linkedin_source_list');

    // A stale error or a stale argument object belonging to another tool is
    // worse than an empty form.
    expect(textarea()?.value).toBe('{}');
    expect(bodyText()).not.toMatch(/invalid json/i);
  });
});

describe('running a tool that is not plainly read-only', () => {
  it('stops for a confirmation first', async () => {
    await mount();
    await choose('linkedin_claim_manage');
    await type('{"action":"verify","claim_id":"clm_nope","confirm":true}');

    expect(await run()).toBe(true);

    // Anything that writes, is destructive, or reaches the network gets a
    // confirmation, because this console can reach all of them.
    expect(dialog()).not.toBeNull();
  });

  it('does not run it when the confirmation is dismissed', async () => {
    await mount();
    const before = listClaims(harness.fixture.db, {}, false).filter(
      (c) => c.state === 'verified',
    ).length;
    const candidate = listClaims(harness.fixture.db, {}, false).find(
      (c) => c.state === 'candidate',
    );
    if (!candidate) return;

    await choose('linkedin_claim_manage');
    await type(JSON.stringify({ action: 'verify', claim_id: candidate.id, confirm: true }));
    await run();

    byLabel(/^cancel$/i)?.click();
    await flush(12);

    expect(
      listClaims(harness.fixture.db, {}, false).filter((c) => c.state === 'verified').length,
    ).toBe(before);
  });

  it('runs it once the confirmation is answered', async () => {
    await mount();
    const candidate = listClaims(harness.fixture.db, {}, false).find(
      (c) => c.state === 'candidate',
    );
    if (!candidate) return;
    const before = listClaims(harness.fixture.db, {}, false).filter(
      (c) => c.state === 'verified',
    ).length;

    await choose('linkedin_claim_manage');
    await type(JSON.stringify({ action: 'verify', claim_id: candidate.id, confirm: true }));
    await run();
    expect(await confirm()).toBe(true);

    expect(
      listClaims(harness.fixture.db, {}, false).filter((c) => c.state === 'verified').length,
    ).toBeGreaterThan(before);
  });

  it('shows a refusal from the tool rather than an empty result', async () => {
    await mount();
    await choose('linkedin_claim_manage');
    await type('{"action":"verify","claim_id":"clm_nope","confirm":true}');
    await run();
    await confirm();

    expect(bodyText()).toMatch(/not found|error|refus/i);
  });
});

describe('what the console does not hide', () => {
  it('offers the destructive tools too, behind their own contracts', async () => {
    await mount();
    await choose('linkedin_purge_run');
    await type('{"mode":"purge_all","confirm_phrase":"delete all local data","confirm":true}');
    await run();
    await confirm();

    // The console does not gate on tool name; the tool's own phrase does the
    // gating, and a lowercase phrase is not the phrase.
    expect(
      Number(harness.fixture.db.get('SELECT COUNT(*) AS n FROM claims')?.['n']),
    ).toBeGreaterThan(0);
  });
});
