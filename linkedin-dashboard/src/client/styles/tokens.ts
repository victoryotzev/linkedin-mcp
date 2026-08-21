// The colour tokens, as data.
//
// This file is the authority; tokens.css must agree with it, and a test asserts
// that it does. Keeping the values here as well as in CSS is what lets the
// contrast matrix be checked deterministically without a browser — happy-dom
// does not compute layout, so axe's contrast rule cannot be trusted there.
//
// Nothing in the client imports this at runtime: it is types and test data.

export type Theme = 'light' | 'dark';

export type ForegroundToken =
  | 'text'
  | 'text-muted'
  | 'text-subtle'
  | 'accent'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'accent-fg'
  | 'danger-fg'
  | 'focus'
  | 'border-strong';

export type SurfaceToken =
  | 'bg'
  | 'surface-1'
  | 'surface-2'
  | 'surface-3'
  | 'accent-wash'
  | 'accent'
  | 'danger';

export type TokenName = ForegroundToken | SurfaceToken | 'border';

// The neutral family is warm rather than cool: this is a room-lit desk tool
// someone reads for long stretches, and the blue-grey it used to sit in read as
// colder than the work deserves. The accent is a deep teal, kept well clear of
// the blue every dashboard reaches for by default, and it earns its place only
// on primary actions, the current selection, and focus.
export const TOKENS: Record<Theme, Record<TokenName, string>> = {
  dark: {
    bg: '#101211',
    'surface-1': '#161918',
    'surface-2': '#1C201F',
    'surface-3': '#232725',
    // Pre-blended rather than a translucent overlay, so its contrast is exactly
    // computable and it survives forced-colors sanely.
    'accent-wash': '#122725',
    border: '#262A28',
    'border-strong': '#6E7370',
    text: '#E9E7E3',
    'text-muted': '#A6A29B',
    'text-subtle': '#948F87',
    accent: '#3FD1C8',
    'accent-fg': '#06201E',
    ok: '#3FBE7C',
    warn: '#E8B23A',
    danger: '#F16A5E',
    'danger-fg': '#1A0406',
    focus: '#5FE0D6',
  },
  light: {
    bg: '#FAFAF9',
    'surface-1': '#FFFFFF',
    'surface-2': '#F2F1EF',
    'surface-3': '#FFFFFF',
    'accent-wash': '#E6F2F1',
    border: '#E4E2DE',
    'border-strong': '#8A8680',
    text: '#1C1B1A',
    'text-muted': '#5B5954',
    'text-subtle': '#67645E',
    // Deepened one step from the teal this started at: at #0E7C7B it missed
    // 4.5:1 on `surface-2` and `accent-wash` — the table header and the selected
    // row, which is exactly where a link is most likely to sit.
    accent: '#0E7877',
    'accent-fg': '#FFFFFF',
    ok: '#147B49',
    warn: '#8A5D00',
    danger: '#C13B34',
    'danger-fg': '#FFFFFF',
    focus: '#0B6A69',
  },
};

/**
 * `--border` is a decorative hairline and is deliberately below 3:1: panels are
 * also separated by background, so the border is never the only thing
 * identifying a region. Anything that DOES carry meaning on its own — an input
 * boundary, a focus ring — uses `--border-strong` or `--focus`, both of which
 * are in the matrix at 3:1.
 */
export const DECORATIVE_TOKENS: readonly TokenName[] = ['border'];
