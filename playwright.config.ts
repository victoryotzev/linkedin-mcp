import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, STORAGE_STATE, VISUAL_HOME, VISUAL_PORT } from './tests/visual/paths.ts';

// Real-browser verification: the evidence happy-dom cannot produce.
//
// It runs against an isolated, seeded dashboard on its own port and its own
// home — never the member's data — and it makes no external network call. This
// is deliberately a separate runner from Vitest and a separate command: it
// needs a browser download, so `npm test` stays offline and fast.

export default defineConfig({
  testDir: './tests/visual',
  outputDir: './test-results/visual',
  // Screenshots are evidence for a human to look at, not pixel baselines to
  // diff. Baselines across machines and font stacks produce failures that say
  // nothing about the interface.
  snapshotDir: './test-results/visual-snapshots',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: './test-results/visual-report', open: 'never' }]],
  globalSetup: './tests/visual/global-setup.ts',

  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    // The dashboard is loopback HTTP by design; the bind address is the
    // transport boundary.
    ignoreHTTPSErrors: false,
    screenshot: 'off',
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npx tsx tests/visual/server.ts',
    // Waits on the TCP port rather than an HTTP response: the guard refuses
    // requests without a Host allowlist match and a same-origin Sec-Fetch-Site,
    // so a plain readiness probe would be answered with 403.
    port: VISUAL_PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VISUAL_HOME, VISUAL_PORT: String(VISUAL_PORT) },
    stdout: 'pipe',
  },
});
