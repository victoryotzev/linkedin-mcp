import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// What a real browser can prove and happy-dom cannot: computed colour contrast,
// genuine reflow under zoom, forced-colors rendering, and what the thing
// actually looks like.

const DESTINATIONS = [
  'overview',
  'evidence',
  'profile',
  'content',
  'publishing',
  'system',
] as const;

const WIDTHS = [
  { name: '1600-desktop', width: 1600, height: 1000 },
  { name: '1280-laptop', width: 1280, height: 900 },
  { name: '1024-small', width: 1024, height: 800 },
  { name: '768-tablet', width: 768, height: 900 },
  { name: '480-split', width: 480, height: 900 },
  // The WCAG 1.4.10 floor: what 1280px at 400% zoom produces.
  { name: '320-reflow', width: 320, height: 900 },
] as const;

const SHOTS = './test-results/visual/screenshots';

async function show(page: Page, destination: string, theme: 'dark' | 'light'): Promise<void> {
  await page.goto(`/#/${destination}`);
  await page.evaluate((value) => {
    document.documentElement.dataset['theme'] = value;
  }, theme);
  await page.waitForSelector('main#main h1');
  // Screens fetch on mount; give the resource states time to settle so the
  // evidence is of loaded content, not of skeletons.
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
    timeout: 10_000,
  });
}

test.describe('screenshot matrix', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const size of WIDTHS) {
      test(`${theme} @ ${size.name}`, async ({ page }, testInfo) => {
        mkdirSync(SHOTS, { recursive: true });
        await page.setViewportSize({ width: size.width, height: size.height });

        for (const destination of DESTINATIONS) {
          await show(page, destination, theme);
          const file = join(SHOTS, `${destination}-${theme}-${size.name}.png`);
          await page.screenshot({ path: file, fullPage: true });
          await testInfo.attach(`${destination}-${theme}-${size.name}`, {
            path: file,
            contentType: 'image/png',
          });
        }
      });
    }
  }
});

test.describe('reflow', () => {
  for (const size of WIDTHS) {
    test(`no horizontal page scroll at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      for (const destination of DESTINATIONS) {
        await show(page, destination, 'dark');
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        // WCAG 1.4.10: content reflows without two-dimensional scrolling. Only
        // excerpts, code blocks and wide tables may scroll, inside their own box.
        expect(
          overflow.scrollWidth,
          `${destination} overflows horizontally at ${size.name}`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      }
    });
  }

  test('the 320px case really is the 400%-zoom case', async ({ page }) => {
    // Page zoom divides the LAYOUT viewport: 1280 CSS px at 400% is a 320 CSS
    // px viewport, and the media queries respond accordingly. The CSS `zoom`
    // property does not do this — it scales used values while the initial
    // containing block stays the window size — so scaling the body is not a
    // test of WCAG 1.4.10 and would fail for reasons that say nothing about
    // the interface.
    //
    // The 320px viewport above is the accurate equivalent. This asserts the
    // narrow layout genuinely engaged there, so that case is measuring reflow
    // rather than a desktop layout that happens not to overflow.
    await page.setViewportSize({ width: 320, height: 900 });
    await show(page, 'evidence', 'dark');

    const layout = await page.evaluate(() => {
      const rail = document.querySelector('.rail');
      const app = document.querySelector('.app');
      return {
        railDisplay: rail ? getComputedStyle(rail).flexDirection : null,
        columns: app ? getComputedStyle(app).gridTemplateColumns : null,
      };
    });
    // At this width the rail is a horizontal top bar and the grid is one column.
    expect(layout.railDisplay).toBe('row');
    expect(layout.columns?.split(' ')).toHaveLength(1);
  });

  test('text resized to 200% does not overflow the page (WCAG 1.4.4)', async ({ page }) => {
    // The browser's text-size setting, which scales the root font while leaving
    // the viewport alone. Everything is sized in rem for exactly this reason.
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const destination of DESTINATIONS) {
      await show(page, destination, 'dark');
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${destination} overflows horizontally at 200% text size`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  });
});

test.describe('the rail stays put', () => {
  test('navigation and the theme toggle remain reachable after scrolling', async ({ page }) => {
    // Reported from real use: the rail was an ordinary grid item, so it was as
    // tall as the page and you had to scroll to the bottom of a long queue to
    // reach the theme toggle.
    await page.setViewportSize({ width: 1440, height: 700 });
    await show(page, 'evidence', 'dark');

    const themeToggle = page.locator('.rail__footer button').first();
    const navLink = page.locator('.rail__link').first();
    await expect(themeToggle).toBeInViewport();

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(
      () => window.scrollY > 0 || document.body.scrollHeight <= innerHeight,
    );

    await expect(themeToggle).toBeInViewport();
    await expect(navLink).toBeInViewport();
  });

  test('scrolls on its own if it outgrows the viewport', async ({ page }) => {
    // A short window must not clip the footer out of reach entirely.
    await page.setViewportSize({ width: 1440, height: 380 });
    await show(page, 'overview', 'dark');
    const overflow = await page.evaluate(() => {
      const rail = document.querySelector('.rail');
      if (!rail) return null;
      return {
        scrollable: rail.scrollHeight > rail.clientHeight,
        overflowY: getComputedStyle(rail).overflowY,
      };
    });
    expect(overflow?.overflowY).toBe('auto');
    if (overflow?.scrollable) {
      const reached = await page.evaluate(() => {
        const rail = document.querySelector('.rail')!;
        rail.scrollTop = rail.scrollHeight;
        return rail.scrollTop > 0;
      });
      expect(reached).toBe(true);
    }
  });
});

test.describe('accessibility in a real browser', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const destination of DESTINATIONS) {
      test(`${destination} passes axe with contrast enabled — ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 950 });
        await show(page, destination, theme);

        // colour-contrast is ENABLED here. This is the check happy-dom cannot
        // run, because it computes no layout — the unit-level pair matrix
        // covers the tokens, and this covers what they actually render as.
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();

        expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual(
          [],
        );
      });
    }
  }
});

test.describe('forced colors', () => {
  test('keeps structure and status legible with colour removed', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize({ width: 1440, height: 950 });
    await show(page, 'publishing', 'dark');

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'publishing-forced-colors.png'), fullPage: true });

    // Status must survive without colour, so every chip carries a glyph and a
    // word as well.
    const chips = page.locator('.chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const text = (await chips.nth(index).innerText()).trim();
      expect(text.replace(/[●◐▲○◆]/gu, '').trim().length).toBeGreaterThan(0);
    }
  });
});

test.describe('reduced motion', () => {
  test('removes transition duration rather than shortening it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await show(page, 'overview', 'dark');
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('.btn, .card, .rail__link')]
        .map((element) => getComputedStyle(element).transitionDuration)
        .filter(Boolean),
    );
    for (const duration of durations) {
      expect(Number.parseFloat(duration)).toBeLessThan(0.002);
    }
  });
});

test.describe('focus', () => {
  test('shows a visible focus ring on the first interactive element', async ({ page }) => {
    await show(page, 'overview', 'dark');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      return { width: style.outlineWidth, style: style.outlineStyle, text: active.textContent };
    });
    expect(outline).not.toBeNull();
    // Skip-to-content is deliberately first.
    expect(outline?.text).toContain('Skip to content');
    expect(Number.parseFloat(outline?.width ?? '0')).toBeGreaterThanOrEqual(2);
    expect(outline?.style).not.toBe('none');
  });
});
