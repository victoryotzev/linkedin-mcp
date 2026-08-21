// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../../linkedin-dashboard/src/client/theme.ts';

// The pre-paint theme script.
//
// It runs synchronously in <head>, before anything is painted, so a member who
// chose dark does not get a white flash on every navigation. That timing is the
// only reason it is a separate file rather than part of the bundle, and it is
// why the module must export nothing: the output is loaded as a classic
// script, where a top-level `export` is a syntax error.
//
// Importing the module is the only way to run it, and a module is evaluated
// once per registry — so each case resets the modules rather than the DOM.

beforeEach(() => {
  vi.resetModules();
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a member who chose a theme', () => {
  it('has it applied before the first paint', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    await import('../../linkedin-dashboard/src/client/theme-boot.ts');

    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('has light applied just as explicitly, so it beats the media query', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    await import('../../linkedin-dashboard/src/client/theme-boot.ts');

    // An explicit choice has to win in both directions; setting only dark would
    // strand a member whose system is dark but who wants light.
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('a member who chose nothing', () => {
  it('is left to the stylesheet, with no attribute stamped', async () => {
    await import('../../linkedin-dashboard/src/client/theme-boot.ts');

    // No attribute means prefers-color-scheme decides, which is the correct
    // default and cannot be expressed by picking one.
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });

  it('ignores a stored value it does not recognise', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');

    await import('../../linkedin-dashboard/src/client/theme-boot.ts');

    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });
});

describe('a browser with no storage at all', () => {
  it('runs without throwing, because a thrown error here blocks the paint', async () => {
    vi.stubGlobal('localStorage', undefined);

    await expect(import('../../linkedin-dashboard/src/client/theme-boot.ts')).resolves.toBeTruthy();
  });

  it('runs without throwing when storage exists but refuses to be read', async () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('storage is disabled');
      },
    });

    // This script sits in <head> and is synchronous: an exception here stops
    // the parser before the stylesheet, which is worse than the wrong colours.
    await expect(import('../../linkedin-dashboard/src/client/theme-boot.ts')).resolves.toBeTruthy();
  });
});
