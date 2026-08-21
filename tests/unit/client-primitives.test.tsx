// @vitest-environment happy-dom
import { createRoot, type Root } from 'hono/jsx/dom/client';
import { useRef } from 'hono/jsx/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusableWithin, useOverlay } from '../../linkedin-dashboard/src/client/lib/a11y.ts';
import {
  CopyButton,
  KeyHint,
  Meta,
} from '../../linkedin-dashboard/src/client/components/Facts.tsx';
import { middleTruncate, pluralise } from '../../linkedin-dashboard/src/client/lib/format.ts';
import {
  applyTheme,
  readStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
} from '../../linkedin-dashboard/src/client/theme.ts';
import { flush } from '../helpers/clientHarness.ts';

// The small pieces the screens are built from.
//
// Each of these is somewhere a member's attention actually lands: the focus
// trap that decides whether a keyboard user can leave a dialog, the truncation
// that decides whether they can tell two paths apart, and the copy button that
// is the only way the product's output reaches LinkedIn.

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
  vi.restoreAllMocks();
});

describe('middle truncation', () => {
  it('leaves a short value alone', () => {
    expect(middleTruncate('README.md')).toBe('README.md');
  });

  it('keeps both ends, because both ends of a path carry meaning', () => {
    const path = 'C:\\Users\\alex\\projects\\backup-verifier\\src\\importers\\zip.ts';
    const shown = middleTruncate(path, 30);

    expect(shown.length).toBeLessThanOrEqual(30);
    // The drive and the filename are what tell two similar paths apart; a tail
    // truncation would leave every one of them reading "C:\Users\alex\proj…".
    expect(shown.startsWith('C:\\Users')).toBe(true);
    expect(shown.endsWith('zip.ts')).toBe(true);
    expect(shown).toContain('…');
  });

  it('respects the width it was given, at any width', () => {
    for (const max of [4, 8, 15, 48]) {
      const shown = middleTruncate('a'.repeat(200), max);
      expect(shown.length, `max ${max}`).toBeLessThanOrEqual(max);
    }
  });
});

describe('pluralising a count', () => {
  it('uses the singular for exactly one', () => {
    expect(pluralise(1, 'claim')).toBe('1 claim');
    expect(pluralise(0, 'claim')).toBe('0 claims');
    expect(pluralise(2, 'claim')).toBe('2 claims');
  });

  it('takes an irregular plural when there is one', () => {
    expect(pluralise(1, 'entry', 'entries')).toBe('1 entry');
    expect(pluralise(3, 'entry', 'entries')).toBe('3 entries');
  });
});

describe('the theme', () => {
  it('reads only the two values it knows', () => {
    const storage = { getItem: (key: string) => (key === THEME_STORAGE_KEY ? 'dark' : null) };
    expect(readStoredTheme(storage)).toBe('dark');

    expect(readStoredTheme({ getItem: () => 'light' })).toBe('light');
    // Anything else means "no stored choice", which is what lets the
    // stylesheet's prefers-color-scheme block decide.
    for (const value of ['neon', '', 'DARK', null]) {
      expect(readStoredTheme({ getItem: () => value }), String(value)).toBeNull();
    }
  });

  it('treats storage that throws as no stored choice', () => {
    // Storage can be disabled outright rather than merely empty, and it throws
    // when it is.
    expect(
      readStoredTheme({
        getItem() {
          throw new Error('storage is disabled');
        },
      }),
    ).toBeNull();
  });

  it('applies a theme to the root element', () => {
    const root2 = document.documentElement;
    applyTheme(root2, 'dark');
    expect(root2.dataset['theme']).toBe('dark');
    applyTheme(root2, 'light');
    expect(root2.dataset['theme']).toBe('light');
  });

  it('stores a choice, and carries on when storage refuses', () => {
    const written: Array<[string, string]> = [];
    storeTheme({ setItem: (k, v) => written.push([k, v]) }, 'dark');
    expect(written).toEqual([[THEME_STORAGE_KEY, 'dark']]);

    // The theme still applies to this page view; it just will not survive a
    // reload, which is not worth interrupting anyone over.
    expect(() =>
      storeTheme(
        {
          setItem() {
            throw new Error('quota exceeded');
          },
        },
        'light',
      ),
    ).not.toThrow();
  });
});

describe('the copy button', () => {
  function mount(value: string): void {
    root = createRoot(container);
    root.render(<CopyButton value={value} label="Copy" />);
  }

  it('copies the value and says so', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    mount('The suite covers 203 test files in total.');
    await flush(6);

    container.querySelector('button')?.click();
    await flush(8);

    expect(written).toEqual(['The suite covers 203 test files in total.']);
    expect(container.textContent).toContain('Copied');
    vi.unstubAllGlobals();
  });

  it('says the clipboard was blocked rather than pretending it worked', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('permission denied');
        },
      },
    });
    mount('some text');
    await flush(6);

    container.querySelector('button')?.click();
    await flush(10);

    // The member is about to paste this into LinkedIn. Silently failing means
    // they paste whatever was in the clipboard before.
    expect(container.textContent).not.toContain('Copied');
    vi.unstubAllGlobals();
  });
});

describe('the small display pieces', () => {
  it('renders a key hint as a kbd element, so it reads as a key', async () => {
    root = createRoot(container);
    root.render(<KeyHint keys="Ctrl-K" />);
    await flush(4);

    expect(container.querySelector('kbd')?.textContent).toBe('Ctrl-K');
  });

  it('renders secondary text without swallowing it', async () => {
    root = createRoot(container);
    root.render(<Meta>just now</Meta>);
    await flush(4);

    expect(container.textContent).toBe('just now');
  });
});

describe('the focus trap', () => {
  function Overlay() {
    const box = useRef<HTMLDivElement | null>(null);
    useOverlay(box, true, () => {});
    return (
      <div ref={box}>
        <button type="button" id="first">
          First
        </button>
        <button type="button" id="middle">
          Middle
        </button>
        <button type="button" id="last">
          Last
        </button>
      </div>
    );
  }

  async function mountOverlay(): Promise<void> {
    root = createRoot(container);
    root.render(<Overlay />);
    await flush(8);
  }

  const press = async (init: KeyboardEventInit) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    await flush(6);
  };

  it('finds the focusable controls inside a container', () => {
    container.innerHTML =
      '<button id="a">a</button><a href="#/x">link</a><input /><button disabled>no</button>';

    const found = focusableWithin(container);
    // A disabled control is not a tab stop, so trapping to it would strand the
    // keyboard user.
    expect(found.length).toBe(3);
  });

  it('wraps Tab from the last control back to the first', async () => {
    await mountOverlay();
    document.getElementById('last')?.focus();

    await press({ key: 'Tab' });

    expect(document.activeElement?.id).toBe('first');
  });

  it('wraps Shift-Tab from the first control back to the last', async () => {
    await mountOverlay();
    document.getElementById('first')?.focus();

    await press({ key: 'Tab', shiftKey: true });

    expect(document.activeElement?.id).toBe('last');
  });

  it('leaves Tab alone in the middle of the list', async () => {
    await mountOverlay();
    document.getElementById('middle')?.focus();

    await press({ key: 'Tab' });

    // The browser's own tab order is correct here; intercepting it would break
    // the one thing the trap is meant to preserve.
    expect(document.activeElement?.id).toBe('middle');
  });

  it('swallows Tab in an overlay with nothing focusable in it', async () => {
    function Empty() {
      const box = useRef<HTMLDivElement | null>(null);
      useOverlay(box, true, () => {});
      return <div ref={box}>nothing to focus</div>;
    }
    root = createRoot(container);
    root.render(<Empty />);
    await flush(8);

    // Letting Tab through would move focus to the page behind the overlay,
    // which is exactly what a trap exists to prevent.
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    await flush(6);

    expect(event.defaultPrevented).toBe(true);
  });
});
