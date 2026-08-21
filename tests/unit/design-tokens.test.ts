import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAIRS } from '../../linkedin-dashboard/src/client/styles/pairs.ts';
import {
  DECORATIVE_TOKENS,
  TOKENS,
  type Theme,
  type TokenName,
} from '../../linkedin-dashboard/src/client/styles/tokens.ts';

// Contrast is a property of a PAIR, not of a token. A palette can be entirely
// compliant token-by-token and still ship unreadable combinations — which is
// exactly what happened when this matrix was first computed: `border-strong`
// came out at 1.6:1 against panels in both themes, and light-theme
// `text-subtle` at 4.23:1 on raised surfaces. Both were corrected before any of
// it reached the interface.
//
// This runs here rather than through axe because axe's colour-contrast rule
// needs real layout, which happy-dom does not compute. The limitation is
// recorded in the plan; the arithmetic below is not a substitute for a
// real-browser pass, but it is deterministic and it catches the whole class.

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

const THEMES: Theme[] = ['dark', 'light'];

const styleFile = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../linkedin-dashboard/src/client/styles/${name}`, import.meta.url)),
    'utf8',
  );

const tokensCss = styleFile('tokens.css');
const baseCss = styleFile('base.css');

describe('colour pair matrix', () => {
  it('covers a meaningful surface, not a token or two', () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(40);
  });

  for (const theme of THEMES) {
    it(`meets its required ratio for every pair in the ${theme} theme`, () => {
      const failures: string[] = [];
      for (const pair of PAIRS) {
        const fg = TOKENS[theme][pair.fg];
        const bg = TOKENS[theme][pair.bg];
        const ratio = contrastRatio(fg, bg);
        if (ratio < pair.min) {
          failures.push(
            `${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}, needs ${pair.min} (${pair.use})`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('states a ratio that matches what the pair is for', () => {
    // 4.5 is the text threshold (1.4.3); 3 is for UI boundaries and indicators
    // (1.4.11). Nothing else is a legitimate target here.
    for (const pair of PAIRS) {
      expect([3, 4.5]).toContain(pair.min);
      const nonText = pair.fg === 'focus' || pair.fg === 'border-strong';
      expect(pair.min).toBe(nonText ? 3 : 4.5);
    }
  });

  it('names every pair, so an unexplained combination cannot creep in', () => {
    for (const pair of PAIRS) {
      expect(pair.use.length).toBeGreaterThan(4);
    }
  });
});

describe('tokens.css and tokens.ts agree', () => {
  function parseBlock(selectorPattern: RegExp): Record<string, string> {
    const match = selectorPattern.exec(tokensCss);
    if (!match) throw new Error(`token block not found: ${selectorPattern}`);
    const out: Record<string, string> = {};
    for (const [, name, value] of match[0].matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) {
      out[name!] = value!.toUpperCase();
    }
    return out;
  }

  it('defines the light values on bare :root, so nothing depends on a media query', () => {
    const css = parseBlock(/:root\s*\{[^}]*\}/);
    for (const [name, value] of Object.entries(TOKENS.light)) {
      expect(`${name}=${css[name]}`).toBe(`${name}=${value.toUpperCase()}`);
    }
  });

  it('defines the dark values under an explicit [data-theme="dark"], so the toggle wins', () => {
    const css = parseBlock(/:root\[data-theme='dark'\]\s*\{[^}]*\}/);
    for (const [name, value] of Object.entries(TOKENS.dark)) {
      expect(`${name}=${css[name]}`).toBe(`${name}=${value.toUpperCase()}`);
    }
  });

  it('repeats the dark values under prefers-color-scheme, guarded against an explicit light choice', () => {
    const block =
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{[^}]*\}/;
    const css = parseBlock(block);
    for (const [name, value] of Object.entries(TOKENS.dark)) {
      expect(`${name}=${css[name]}`).toBe(`${name}=${value.toUpperCase()}`);
    }
  });

  it('ships a foreground utility for every token a pair can use', () => {
    const foregrounds = new Set(PAIRS.map((pair) => pair.fg));
    for (const fg of foregrounds) {
      expect(tokensCss).toContain(`.u-fg-${fg} { color: var(--${fg}); }`);
    }
  });
});

describe('motion and forced colors', () => {
  it('honours prefers-reduced-motion by removing duration, not by shortening it', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/.exec(baseCss)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('animation-duration: 0.01ms !important');
    expect(block).toContain('transition-duration: 0.01ms !important');
    expect(block).toContain('animation-iteration-count: 1 !important');
  });

  it('replaces colour with borders and system colours under forced-colors', () => {
    const block = /@media \(forced-colors: active\)\s*\{[\s\S]*?\n\}/.exec(baseCss)?.[0];
    expect(block).toBeDefined();
    // Filled buttons lose their background entirely in forced-colors, so they
    // need an explicit boundary or they vanish.
    expect(block).toContain('CanvasText');
    expect(block).toContain('ButtonText');
    expect(block).toContain('Highlight');
  });

  it('keeps a visible focus indicator with an offset', () => {
    expect(baseCss).toContain('outline: 2px solid var(--focus)');
    expect(baseCss).toContain('outline-offset: 2px');
    // WCAG 2.4.11: sticky chrome must not obscure the focused element.
    expect(baseCss).toContain('scroll-margin');
  });
});

describe('decorative tokens', () => {
  it('excludes the hairline border from the matrix, and says why', () => {
    // `--border` sits below 3:1 on purpose: panels are also separated by
    // background, so it is never the only thing identifying a region. Anything
    // that carries meaning alone uses --border-strong or --focus, both of which
    // ARE in the matrix.
    expect(DECORATIVE_TOKENS).toContain('border' satisfies TokenName);
    for (const pair of PAIRS) {
      expect(DECORATIVE_TOKENS).not.toContain(pair.fg);
    }
    for (const theme of THEMES) {
      expect(contrastRatio(TOKENS[theme]['border'], TOKENS[theme]['surface-1'])).toBeLessThan(3);
      expect(
        contrastRatio(TOKENS[theme]['border-strong'], TOKENS[theme]['surface-1']),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
