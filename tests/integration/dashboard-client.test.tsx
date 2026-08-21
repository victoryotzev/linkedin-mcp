// @vitest-environment happy-dom
import { useState } from 'hono/jsx/dom';
import { createRoot } from 'hono/jsx/dom/client';
import type { Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../linkedin-dashboard/src/client/AppShell.tsx';
import { ConfirmDialog } from '../../linkedin-dashboard/src/client/components/Overlay.tsx';
import {
  createPalette,
  PaletteRegistry,
} from '../../linkedin-dashboard/src/client/lib/commands.ts';
import { DESTRUCTIVE_ACTION_IDS } from '../../linkedin-dashboard/src/client/lib/destructive.ts';
import { establishSession } from '../../linkedin-dashboard/src/client/lib/api.ts';
import { parseHash, routeToHash } from '../../linkedin-dashboard/src/client/lib/router.ts';
import { THEME_STORAGE_KEY } from '../../linkedin-dashboard/src/client/theme.ts';
import { BOOT_FALLBACK_HEADING } from '../../linkedin-dashboard/src/html.ts';

// The first tests in this repository that execute browser code.
//
// The old dashboard could not have any: its client was a string inside a
// template literal, and the node:vm sandbox guarding it stubbed
// querySelectorAll to return [] — so every addEventListener body, the whole
// nav, and every mutation handler went unexecuted. A missing render function
// once killed the page at load and shipped undetected for two phases.
//
// Here components are mounted for real, clicked for real, and typed into.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const testId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

let container: HTMLElement;
let mountedRoots: Root[];

function createTestRoot(element: HTMLElement): Root {
  const root = createRoot(element);
  mountedRoots.push(root);
  return root;
}

beforeEach(() => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'fetch').mockImplementation(fetchMock);
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
  location.hash = '';
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
  mountedRoots = [];
});

afterEach(async () => {
  for (const root of mountedRoots) root.unmount();
  await flush();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session bootstrap', () => {
  it('recovers from a failed launch-token exchange instead of leaving a blank checking view', async () => {
    location.hash = '#t=single-use-token';
    vi.mocked(window.fetch).mockRejectedValue(new Error('server unavailable'));

    await expect(establishSession()).resolves.toBe(false);
    // The token goes even when the exchange never reached the server, and it is
    // stripped to nothing rather than replaced with a route.
    expect(location.hash).toBe('');
    expect(location.hash).not.toContain('single-use-token');
  });
});

async function mountShell(): Promise<void> {
  createTestRoot(container).render(<AppShell />);
  await flush();
}

describe('app shell', () => {
  it('renders the six destinations with a labelled navigation landmark', async () => {
    await mountShell();
    const nav = container.querySelector('nav[aria-label="Sections"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelectorAll('a.rail__link')).toHaveLength(7);
  });

  it('exposes one h1 and a skip link, so the page has a spine', async () => {
    await mountShell();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const skip = container.querySelector<HTMLAnchorElement>('.skip-link');
    expect(skip?.getAttribute('href')).toBe('#main');
    expect(container.querySelector('#main')?.tagName.toLowerCase()).toBe('main');
  });

  it('marks the current destination for assistive technology, not only visually', async () => {
    await mountShell();
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Overview');
  });

  it('follows the hash to another destination', async () => {
    await mountShell();
    location.hash = '#/publishing';
    dispatchEvent(new Event('hashchange'));
    await flush();

    expect(container.querySelector('h1')?.textContent).toBe('Publishing');
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('Publishing');
  });

  it('describes what each destination is for', async () => {
    await mountShell();
    expect(container.textContent).toContain('What needs a decision, what is blocked');

    location.hash = '#/evidence';
    dispatchEvent(new Event('hashchange'));
    await flush();
    expect(container.textContent).toContain('Claims, the evidence under them');
  });
});

describe('theme', () => {
  it('toggles, applies to the document, and persists under the key the boot script reads', async () => {
    await mountShell();
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      /theme/i.test(element.textContent ?? ''),
    );
    expect(button).toBeDefined();

    button?.click();
    await flush();

    const applied = document.documentElement.dataset['theme'];
    expect(applied === 'light' || applied === 'dark').toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(applied);
  });

  it('honours an explicit choice already applied by the pre-paint boot script', async () => {
    document.documentElement.dataset['theme'] = 'light';
    await mountShell();
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      /theme/i.test(element.textContent ?? ''),
    );
    // Showing "Dark theme" means it read light as the current state rather than
    // falling back to the system preference.
    expect(button?.textContent).toContain('Dark theme');
  });
});

describe('router', () => {
  it('parses destinations, sub-views and the detail id', () => {
    expect(parseHash('#/evidence/queue')).toEqual({
      destination: 'evidence',
      view: 'queue',
      id: null,
    });
    expect(parseHash('#/publishing/approvals?id=apv_123')).toEqual({
      destination: 'publishing',
      view: 'approvals',
      id: 'apv_123',
    });
  });

  it('falls back to overview rather than throwing on anything unrecognised', () => {
    // The launch URL is '/#t=<token>', so this exact shape reaches the router
    // before the token is exchanged and stripped.
    expect(parseHash('#t=abc123')).toEqual({ destination: 'overview', view: null, id: null });
    expect(parseHash('')).toEqual({ destination: 'overview', view: null, id: null });
    expect(parseHash('#/nonsense')).toEqual({ destination: 'overview', view: null, id: null });
  });

  it('round-trips', () => {
    const route = { destination: 'system' as const, view: 'audit', id: 'evt_1' };
    expect(parseHash(routeToHash(route))).toEqual(route);
  });
});

describe('command palette safety', () => {
  it('contains no irreversible action', () => {
    const ids = new Set(
      createPalette()
        .list()
        .map((command) => command.id),
    );
    for (const destructive of DESTRUCTIVE_ACTION_IDS) {
      expect(ids.has(destructive)).toBe(false);
    }
  });

  it('refuses to register one, loudly', () => {
    const palette = new PaletteRegistry();
    expect(() =>
      palette.register({ id: 'approval.grant', label: 'Grant approval', run: () => {} }),
    ).toThrow(/refusing to put destructive action/);
    expect(palette.list()).toHaveLength(0);
  });

  it('still offers navigation to every destination', () => {
    const labels = createPalette()
      .list()
      .map((command) => command.label);
    expect(labels).toContain('Go to Publishing');
    expect(labels).toContain('Go to Evidence');
  });
});

describe('confirmation dialog', () => {
  function mountConfirm(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    createTestRoot(container).render(
      <ConfirmDialog
        open
        title="Reject this claim permanently"
        consequence="The statement becomes a tombstone and cannot be re-proposed."
        confirmLabel="Reject permanently"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...overrides}
      />,
    );
    return { onConfirm, onCancel };
  }

  it('states the consequence rather than asking whether the user is sure', async () => {
    mountConfirm();
    await flush();
    expect(document.body.textContent).toContain('becomes a tombstone');
    expect(document.body.textContent).not.toContain('Are you sure');
  });

  it('does not put initial focus on the affirmative control', async () => {
    mountConfirm();
    await flush();
    // A stray Enter on a freshly-opened dialog must not approve or delete
    // anything, so focus lands on Cancel.
    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('is a modal dialog with an accessible name', async () => {
    mountConfirm();
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog?.getAttribute('aria-labelledby');
    expect(document.getElementById(labelId ?? '')?.textContent).toBe(
      'Reject this claim permanently',
    );
  });

  it('closes on Escape without confirming', async () => {
    const { onConfirm, onCancel } = mountConfirm();
    await flush();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps the affirmative control disabled until an exact phrase is typed', async () => {
    mountConfirm({ requiredPhrase: 'DELETE ALL LOCAL DATA' });
    await flush();

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === 'Reject permanently',
    );
    expect(confirm?.disabled).toBe(true);

    const input = document.querySelector<HTMLInputElement>('.field__control');
    if (input) {
      input.value = 'DELETE ALL LOCAL DATA';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await flush();

    const after = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === 'Reject permanently',
    );
    expect(after?.disabled).toBe(false);
  });

  it('returns focus to whatever opened it', async () => {
    // Opening an overlay from a row and being dumped at the top of the document
    // when it closes is how keyboard users lose their place in a long queue.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            Open
          </button>
          <ConfirmDialog
            open={open}
            title="Reject this claim permanently"
            consequence="The statement becomes a tombstone."
            confirmLabel="Reject permanently"
            destructive
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    createTestRoot(container).render(<Harness />);
    await flush();

    const opener = testId('opener') as HTMLButtonElement;
    opener.focus();
    opener.click();
    await flush();
    expect(document.activeElement?.textContent).toBe('Cancel');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    expect(document.activeElement).toBe(opener);
  });

  it('cannot be submitted twice while a request is in flight', async () => {
    mountConfirm({ pending: true });
    await flush();

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      element.textContent?.includes('Reject permanently'),
    );
    expect(confirm?.disabled).toBe(true);
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
  });
});

describe('boot fallback contract', () => {
  it('is replaced by the client, so it is visible only when the client is dead', async () => {
    document.body.innerHTML = `<div id="root"><div class="boot-fallback"><h1>${BOOT_FALLBACK_HEADING}</h1></div></div>`;
    expect(document.body.textContent).toContain(BOOT_FALLBACK_HEADING);

    const { dashboardRoot } = await import('../../linkedin-dashboard/src/client/main.tsx');
    if (dashboardRoot) mountedRoots.push(dashboardRoot);
    await flush();

    expect(document.body.textContent).not.toContain(BOOT_FALLBACK_HEADING);
    expect(document.querySelector('nav[aria-label="Sections"]')).not.toBeNull();
    expect(testId('spike')).toBeNull();
  });
});
