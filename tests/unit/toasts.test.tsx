// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearToasts,
  dismissToast,
  pushToast,
  Toaster,
} from '../../linkedin-dashboard/src/client/components/Toast.tsx';
import { flush } from '../helpers/clientHarness.ts';

// Toasts, and the reason there are two live regions rather than one.
//
// Politeness differs by tone. A success should not interrupt whatever a screen
// reader is in the middle of; a failure should, because the member may be about
// to do the next thing on the assumption the last one worked. Getting that
// backwards is silent for a sighted member and loud for everyone else.

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  clearToasts();
  document.body.innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount') as HTMLElement;
});

afterEach(() => {
  root?.unmount();
  root = null;
  clearToasts();
  document.body.innerHTML = '';
});

async function mount(): Promise<void> {
  root = createRoot(container);
  root.render(<Toaster />);
  await flush(8);
}

const toasts = () => Array.from(container.querySelectorAll<HTMLElement>('.toast'));
const region = (role: string) => container.querySelector<HTMLElement>(`[role="${role}"]`);
const text = () => container.textContent ?? '';

describe('showing one', () => {
  it('renders the message, and the detail when there is one', async () => {
    await mount();

    pushToast('ok', 'Backup created', '412 entries all match.');
    await flush(8);

    expect(text()).toContain('Backup created');
    expect(text()).toContain('412 entries all match.');
  });

  it('renders without a detail', async () => {
    await mount();

    pushToast('ok', 'Validation re-run');
    await flush(8);

    expect(toasts()).toHaveLength(1);
    expect(text()).toContain('Validation re-run');
  });

  it('marks tone with a glyph, so meaning survives without colour', async () => {
    await mount();

    pushToast('ok', 'It worked');
    pushToast('danger', 'It did not');
    await flush(8);

    const glyphs = Array.from(container.querySelectorAll('.toast__glyph')).map(
      (g) => g.textContent,
    );
    expect(glyphs).toEqual(['●', '▲']);
    // Decorative: the tone is already carried by the live region and the text.
    for (const glyph of container.querySelectorAll('.toast__glyph')) {
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('the two live regions', () => {
  it('announces a success politely', async () => {
    await mount();

    pushToast('ok', 'Approval granted');
    await flush(8);

    const polite = region('status');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(polite?.textContent).toContain('Approval granted');
    // And not in the assertive one, which would interrupt for no reason.
    expect(region('alert')?.textContent ?? '').not.toContain('Approval granted');
  });

  it('announces a failure assertively', async () => {
    await mount();

    pushToast('danger', 'Purge was refused');
    await flush(8);

    const assertive = region('alert');
    expect(assertive?.getAttribute('aria-live')).toBe('assertive');
    expect(assertive?.textContent).toContain('Purge was refused');
    // A member about to do the next thing needs to hear this before they do.
    expect(region('status')?.textContent ?? '').not.toContain('Purge was refused');
  });

  it('keeps both regions off screen but in the accessibility tree', async () => {
    await mount();
    pushToast('ok', 'Something happened');
    await flush(8);

    // Visually the toast itself is the announcement; the regions exist so it is
    // also spoken, and duplicating the text on screen would be noise.
    expect(region('status')?.className).toContain('u-visually-hidden');
    expect(region('alert')?.className).toContain('u-visually-hidden');
  });

  it('joins several messages of one tone into a single announcement', async () => {
    await mount();

    pushToast('ok', 'First thing');
    pushToast('ok', 'Second thing');
    await flush(8);

    expect(region('status')?.textContent).toContain('First thing');
    expect(region('status')?.textContent).toContain('Second thing');
  });
});

describe('dismissing', () => {
  it('removes the one that was dismissed and leaves the rest', async () => {
    await mount();

    pushToast('ok', 'Keep me');
    pushToast('danger', 'Dismiss me');
    await flush(8);
    expect(toasts()).toHaveLength(2);

    const dismissButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    dismissButtons[1]?.click();
    await flush(8);

    expect(text()).toContain('Keep me');
    expect(text()).not.toContain('Dismiss me');
  });

  it('can be dismissed by id from outside the component', async () => {
    await mount();

    const id = pushToast('ok', 'Programmatic');
    await flush(8);
    expect(toasts()).toHaveLength(1);

    dismissToast(id);
    await flush(8);
    expect(toasts()).toHaveLength(0);
  });

  it('ignores an id that is not showing', async () => {
    await mount();
    pushToast('ok', 'Still here');
    await flush(8);

    dismissToast(-1);
    await flush(8);

    expect(toasts()).toHaveLength(1);
  });

  it('clears everything at once', async () => {
    await mount();
    pushToast('ok', 'One');
    pushToast('danger', 'Two');
    await flush(8);

    clearToasts();
    await flush(8);

    expect(toasts()).toHaveLength(0);
    expect(region('status')?.textContent ?? '').toBe('');
    expect(region('alert')?.textContent ?? '').toBe('');
  });
});

describe('a toast raised before anything is listening', () => {
  it('is showing by the time the host mounts', async () => {
    pushToast('danger', 'Something failed during boot');

    await mount();

    // The store lives outside the component, so a message raised while the
    // host is still mounting is not lost.
    expect(text()).toContain('Something failed during boot');
  });
});
