import { applyTheme, readStoredTheme } from './theme.ts';

// Runs synchronously in <head>, before first paint, so a stored theme override
// never flashes the wrong colours. It is a separate file rather than an inline
// script because the new surface ships `script-src 'self'` with no nonce, and a
// separate CLASSIC script rather than a module because modules are always
// deferred — which is exactly the flash this exists to prevent.
//
// This module must therefore export nothing: the bundle is emitted as ESM, and
// a top-level `export` would be a syntax error in a classic script. The
// bundle-integrity test asserts that.

if (typeof localStorage !== 'undefined') {
  const stored = readStoredTheme(localStorage);
  if (stored !== null) {
    applyTheme(document.documentElement, stored);
  }
}
