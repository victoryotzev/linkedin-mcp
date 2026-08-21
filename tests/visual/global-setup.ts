import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { VISUAL_HOME, STORAGE_STATE } from './paths.ts';

// Spends the single-use launch token exactly once and stores the resulting
// session, so every test file reuses it instead of racing for a token that only
// works for the first caller.
//
// This is also the one place the guard's Sec-Fetch-Site rule matters: a real
// top-level navigation sends `none`, which the guard accepts. Extension- or
// driver-initiated navigations present as `cross-site` and are refused — that
// is the protection working, and it is not relaxed for testing.

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const launch = JSON.parse(readFileSync(join(VISUAL_HOME, 'launch.json'), 'utf8')) as {
    url: string;
    token: string;
  };

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${launch.url}/#t=${launch.token}`);
  // The client exchanges the fragment token for a cookie on mount, then strips
  // it from the address bar.
  await page.waitForFunction(() => !location.hash.includes('t='), undefined, { timeout: 15_000 });
  await page.waitForSelector('nav[aria-label="Sections"]');

  await context.storageState({ path: STORAGE_STATE });
  await browser.close();
}
