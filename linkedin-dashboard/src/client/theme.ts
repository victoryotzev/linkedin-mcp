// Theme state, shared by the pre-paint boot script and the app.
//
// Three states, deliberately: no stored choice means the stylesheet's
// prefers-color-scheme block decides, and an explicit choice always wins over
// it in both directions.

export const THEME_STORAGE_KEY = 'linkedin_mcp.theme';

export type Theme = 'light' | 'dark';

export function readStoredTheme(storage: Pick<Storage, 'getItem'>): Theme | null {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Storage can throw outright when it is disabled, not merely return null.
    return null;
  }
}

export function storeTheme(storage: Pick<Storage, 'setItem'>, theme: Theme): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies to this page view; it just will not survive a
    // reload. Not worth interrupting the user over.
  }
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset['theme'] = theme;
}

/** The theme in effect right now: an explicit choice if one is set, else the system preference. */
export function effectiveTheme(root: HTMLElement, prefersLight: boolean): Theme {
  const attribute = root.dataset['theme'];
  if (attribute === 'light' || attribute === 'dark') return attribute;
  return prefersLight ? 'light' : 'dark';
}
