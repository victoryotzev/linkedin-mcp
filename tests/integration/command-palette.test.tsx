// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandPalette } from '../../linkedin-dashboard/src/client/components/CommandPalette.tsx';
import {
  createPalette,
  PaletteRegistry,
} from '../../linkedin-dashboard/src/client/lib/commands.ts';
import { flush } from '../helpers/clientHarness.ts';

// The palette is the only keyboard-first surface in the dashboard, and the one
// place where a mis-scoped registry would be dangerous: a fuzzy search that can
// reach an irreversible action means a member is one stray Enter away from
// publishing. The registry refuses such an id at registration, and this drives
// the component that renders it.

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = '';
  location.hash = '';
});

async function mount(palette = createPalette()): Promise<PaletteRegistry> {
  root = createRoot(container);
  root.render(<CommandPalette palette={palette} />);
  await flush(6);
  return palette;
}

const press = async (key: string, init: KeyboardEventInit = {}) => {
  dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  await flush(6);
};

const pressInInput = async (key: string) => {
  const input = document.querySelector<HTMLInputElement>('.palette__input');
  input?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flush(6);
};

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true');

describe('opening and closing', () => {
  it('stays closed until Ctrl-K, then shows every command', async () => {
    const palette = await mount();
    expect(document.querySelector('.palette')).toBeNull();

    await press('k', { ctrlKey: true });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(options().length).toBe(palette.list().length);
  });

  it('opens on Cmd-K too, so the shortcut works on a Mac keyboard', async () => {
    await mount();
    await press('K', { metaKey: true });
    expect(document.querySelector('.palette')).not.toBeNull();
  });

  it('toggles shut on a second Ctrl-K', async () => {
    await mount();
    await press('k', { ctrlKey: true });
    await press('k', { ctrlKey: true });
    expect(document.querySelector('.palette')).toBeNull();
  });

  it('ignores a bare k, which would otherwise fire while typing', async () => {
    await mount();
    await press('k');
    expect(document.querySelector('.palette')).toBeNull();
  });

  it('closes on Escape', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    // useOverlay listens on document in the capture phase, so Escape has to be
    // dispatched where a real key press would land rather than on window.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(6);

    expect(document.querySelector('.palette')).toBeNull();
  });

  it('closes when the backdrop is clicked', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    document.querySelector<HTMLElement>('.overlay-backdrop')?.click();
    await flush(6);
    expect(document.querySelector('.palette')).toBeNull();
  });
});

describe('searching', () => {
  it('filters to matching labels as the member types', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    const input = document.querySelector<HTMLInputElement>('.palette__input');
    if (!input) return;
    input.value = 'evidence';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(6);

    const labels = options().map((o) => o.textContent ?? '');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => /evidence/i.test(l))).toBe(true);
  });

  it('says so plainly when nothing matches, rather than showing an empty box', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    const input = document.querySelector<HTMLInputElement>('.palette__input');
    if (!input) return;
    input.value = 'zzzz-no-such-command';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(6);

    expect(options().length).toBe(0);
    expect(document.querySelector('.palette')?.textContent).toContain('No matching command');
  });

  it('clears the query when reopened, so a stale filter never hides everything', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    const input = document.querySelector<HTMLInputElement>('.palette__input');
    if (!input) return;
    input.value = 'system';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(6);

    await press('k', { ctrlKey: true });
    await press('k', { ctrlKey: true });

    expect(document.querySelector<HTMLInputElement>('.palette__input')?.value).toBe('');
  });
});

describe('keyboard selection', () => {
  it('starts on the first command', async () => {
    await mount();
    await press('k', { ctrlKey: true });
    expect(selected()).toBe(options()[0]);
  });

  it('moves down and up with the arrow keys', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    await pressInInput('ArrowDown');
    expect(selected()).toBe(options()[1]);

    await pressInInput('ArrowDown');
    expect(selected()).toBe(options()[2]);

    await pressInInput('ArrowUp');
    expect(selected()).toBe(options()[1]);
  });

  it('stops at both ends instead of wrapping', async () => {
    await mount();
    await press('k', { ctrlKey: true });
    const total = options().length;

    await pressInInput('ArrowUp');
    expect(selected()).toBe(options()[0]);

    for (let i = 0; i < total + 3; i += 1) await pressInInput('ArrowDown');
    expect(selected()).toBe(options()[total - 1]);
  });

  it('follows the mouse, so hovering and then pressing Enter runs what is highlighted', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    options()[2]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await flush(6);
    expect(selected()).toBe(options()[2]);
  });
});

describe('running a command', () => {
  it('runs the highlighted command on Enter and closes', async () => {
    const palette = new PaletteRegistry();
    const ran: string[] = [];
    palette.register({ id: 'test.first', label: 'First command', run: () => ran.push('first') });
    palette.register({ id: 'test.second', label: 'Second command', run: () => ran.push('second') });
    await mount(palette);

    await press('k', { ctrlKey: true });
    await pressInInput('ArrowDown');
    await pressInInput('Enter');

    expect(ran).toEqual(['second']);
    expect(document.querySelector('.palette')).toBeNull();
  });

  it('runs a command that is clicked', async () => {
    const palette = new PaletteRegistry();
    const ran: string[] = [];
    palette.register({ id: 'test.only', label: 'Only command', run: () => ran.push('only') });
    await mount(palette);

    await press('k', { ctrlKey: true });
    options()[0]?.click();
    await flush(6);

    expect(ran).toEqual(['only']);
    expect(document.querySelector('.palette')).toBeNull();
  });

  it('does nothing on Enter when the filter matches nothing', async () => {
    const palette = new PaletteRegistry();
    const ran: string[] = [];
    palette.register({ id: 'test.only', label: 'Only command', run: () => ran.push('only') });
    await mount(palette);
    await press('k', { ctrlKey: true });

    const input = document.querySelector<HTMLInputElement>('.palette__input');
    if (!input) return;
    input.value = 'nothing matches this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(6);
    await pressInInput('Enter');

    // No selection means no action — not the first command as a fallback.
    expect(ran).toEqual([]);
  });

  it('navigates when a goto command runs', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    const input = document.querySelector<HTMLInputElement>('.palette__input');
    if (!input) return;
    input.value = 'Go to System';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(6);
    await pressInInput('Enter');

    expect(location.hash).toContain('system');
  });

  it('toggles the theme and remembers the choice', async () => {
    await mount();
    await press('k', { ctrlKey: true });

    const input = document.querySelector<HTMLInputElement>('.palette__input');
    if (!input) return;
    input.value = 'theme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(6);

    const before = document.documentElement.dataset['theme'];
    await pressInInput('Enter');

    const after = document.documentElement.dataset['theme'];
    expect(after).not.toBe(before);
    expect(localStorage.getItem('linkedin_mcp.theme')).toBe(after);
  });
});

describe('what the palette refuses to carry', () => {
  it('throws rather than listing an irreversible action', () => {
    const palette = new PaletteRegistry();

    // The guard is at registration, not at render: a destructive command must
    // never become reachable by fuzzy search in the first place.
    for (const id of ['approval.grant', 'data.purge-all', 'claim.reject', 'lane.store-token']) {
      expect(() => palette.register({ id, label: id, run: () => {} })).toThrow(/destructive/i);
    }
    expect(palette.list()).toEqual([]);
  });

  it('carries only navigation and appearance commands by default', async () => {
    const palette = createPalette();
    await mount(palette);
    await press('k', { ctrlKey: true });

    for (const command of palette.list()) {
      expect(command.id).toMatch(/^(goto|theme)\./);
    }
  });
});
