import type { ForegroundToken, SurfaceToken } from './tokens.ts';

// The colour-pair matrix: every (foreground, background) combination the design
// actually uses, with the ratio it must meet.
//
// A token list alone proves nothing — contrast is a property of a PAIR, and it
// is entirely possible to ship compliant tokens in a failing combination. That
// is not hypothetical: `border-strong` and light-theme `text-subtle` both
// failed when this matrix was first computed, and the values in tokens.ts were
// corrected before any of it shipped.
//
// Components choose a foreground through `pairClass`, whose parameter type is
// derived from this array. An unlisted combination is a compile error, so an
// unverified pair cannot reach the interface.

export interface ColourPair {
  readonly fg: ForegroundToken;
  readonly bg: SurfaceToken;
  /** 4.5 for text (WCAG 1.4.3), 3 for UI boundaries and indicators (1.4.11). */
  readonly min: number;
  readonly use: string;
}

export const PAIRS = [
  // Body and secondary text on every surface it can land on.
  { fg: 'text', bg: 'bg', min: 4.5, use: 'page-level text' },
  { fg: 'text', bg: 'surface-1', min: 4.5, use: 'panel text' },
  { fg: 'text', bg: 'surface-2', min: 4.5, use: 'table header, hovered row' },
  { fg: 'text', bg: 'surface-3', min: 4.5, use: 'dialog and drawer text' },
  { fg: 'text', bg: 'accent-wash', min: 4.5, use: 'selected row text' },
  { fg: 'text-muted', bg: 'bg', min: 4.5, use: 'page-level secondary' },
  { fg: 'text-muted', bg: 'surface-1', min: 4.5, use: 'panel secondary' },
  { fg: 'text-muted', bg: 'surface-2', min: 4.5, use: 'column labels' },
  { fg: 'text-muted', bg: 'surface-3', min: 4.5, use: 'dialog secondary' },
  { fg: 'text-muted', bg: 'accent-wash', min: 4.5, use: 'selected row secondary' },
  { fg: 'text-subtle', bg: 'bg', min: 4.5, use: 'page-level meta, result counts' },
  { fg: 'text-subtle', bg: 'surface-1', min: 4.5, use: 'timestamps, ids' },
  { fg: 'text-subtle', bg: 'surface-2', min: 4.5, use: 'meta in table headers' },
  { fg: 'text-subtle', bg: 'surface-3', min: 4.5, use: 'dialog meta' },
  { fg: 'text-subtle', bg: 'accent-wash', min: 4.5, use: 'selected row meta' },

  // Status. Every one of these is paired with a glyph and a word in the UI, so
  // colour is never the only carrier — but it still has to be readable.
  { fg: 'accent', bg: 'bg', min: 4.5, use: 'links at page level' },
  { fg: 'accent', bg: 'surface-1', min: 4.5, use: 'links, active nav' },
  { fg: 'accent', bg: 'surface-2', min: 4.5, use: 'links in headers' },
  { fg: 'accent', bg: 'surface-3', min: 4.5, use: 'links in dialogs' },
  { fg: 'accent', bg: 'accent-wash', min: 4.5, use: 'selected row accent' },
  { fg: 'ok', bg: 'bg', min: 4.5, use: 'verified, intact, succeeded' },
  { fg: 'ok', bg: 'surface-1', min: 4.5, use: 'verified, intact, succeeded' },
  { fg: 'ok', bg: 'surface-2', min: 4.5, use: 'status in table rows' },
  { fg: 'ok', bg: 'surface-3', min: 4.5, use: 'status in dialogs' },
  { fg: 'ok', bg: 'accent-wash', min: 4.5, use: 'status in selected rows' },
  { fg: 'warn', bg: 'bg', min: 4.5, use: 'pending, configured, expiring' },
  { fg: 'warn', bg: 'surface-1', min: 4.5, use: 'pending, configured, expiring' },
  { fg: 'warn', bg: 'surface-2', min: 4.5, use: 'status in table rows' },
  { fg: 'warn', bg: 'surface-3', min: 4.5, use: 'status in dialogs' },
  { fg: 'warn', bg: 'accent-wash', min: 4.5, use: 'status in selected rows' },
  { fg: 'danger', bg: 'bg', min: 4.5, use: 'irreversible, broken, rejected' },
  { fg: 'danger', bg: 'surface-1', min: 4.5, use: 'irreversible, broken, rejected' },
  { fg: 'danger', bg: 'surface-2', min: 4.5, use: 'status in table rows' },
  { fg: 'danger', bg: 'surface-3', min: 4.5, use: 'confirmation dialogs' },
  { fg: 'danger', bg: 'accent-wash', min: 4.5, use: 'status in selected rows' },

  // Text on a filled control.
  { fg: 'accent-fg', bg: 'accent', min: 4.5, use: 'primary button label' },
  { fg: 'danger-fg', bg: 'danger', min: 4.5, use: 'destructive button label' },

  // Non-text: 1.4.11 wants 3:1 for anything that identifies a control or state.
  { fg: 'focus', bg: 'bg', min: 3, use: 'focus ring at page level' },
  { fg: 'focus', bg: 'surface-1', min: 3, use: 'focus ring on panels' },
  { fg: 'focus', bg: 'surface-2', min: 3, use: 'focus ring on rows' },
  { fg: 'focus', bg: 'surface-3', min: 3, use: 'focus ring in dialogs' },
  { fg: 'focus', bg: 'accent-wash', min: 3, use: 'focus ring on selected rows' },
  { fg: 'border-strong', bg: 'bg', min: 3, use: 'input boundary' },
  { fg: 'border-strong', bg: 'surface-1', min: 3, use: 'input boundary' },
  { fg: 'border-strong', bg: 'surface-2', min: 3, use: 'input boundary' },
  { fg: 'border-strong', bg: 'surface-3', min: 3, use: 'input boundary in dialogs' },
  { fg: 'border-strong', bg: 'accent-wash', min: 3, use: 'input boundary when selected' },
] as const satisfies readonly ColourPair[];

// Distributive, so the union is the exact listed tuples rather than the cross
// product of every foreground with every background.
type KeyOf<T> = T extends { fg: infer F extends string; bg: infer B extends string }
  ? `${F}/${B}`
  : never;

/** e.g. `'text-muted/surface-2'`. Only combinations present in PAIRS exist. */
export type PairKey = KeyOf<(typeof PAIRS)[number]>;

/**
 * The foreground utility class for a verified pair. The background is already
 * painted by the container; naming it here is what makes the combination
 * checkable — passing an unlisted one does not compile.
 *
 * Derived rather than looked up, so PAIRS itself is tree-shaken out of the
 * browser bundle and stays test-only data.
 */
export function pairClass(pair: PairKey): string {
  return `u-fg-${pair.slice(0, pair.indexOf('/'))}`;
}
