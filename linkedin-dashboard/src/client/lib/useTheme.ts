import { useState } from 'hono/jsx/dom';
import { applyTheme, effectiveTheme, storeTheme, type Theme } from '../theme.ts';

// Deliberately not in theme.ts: that module is imported by theme-boot.ts, which
// is a separate ~280-byte classic script loaded synchronously in <head>. A hono
// import there would drag the whole JSX runtime into the pre-paint path.

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() =>
    effectiveTheme(document.documentElement, matchMedia('(prefers-color-scheme: light)').matches),
  );

  return {
    theme,
    toggle: () => {
      const next: Theme = theme === 'dark' ? 'light' : 'dark';
      applyTheme(document.documentElement, next);
      storeTheme(localStorage, next);
      setTheme(next);
    },
  };
}
