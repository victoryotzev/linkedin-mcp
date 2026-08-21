import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Browser-side tests are .tsx and compile against the same JSX runtime the
  // bundler uses, so a component that typechecks here is the component that
  // ships. Server tests are unaffected — they contain no JSX.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx/dom',
  },
  resolve: {
    alias: {
      '@linkedin-mcp/shared': r('./packages/shared/src/index.ts'),
      '@linkedin-mcp/db': r('./packages/db/src/index.ts'),
      '@linkedin-mcp/domain': r('./packages/domain/src/index.ts'),
      '@linkedin-mcp/importers': r('./packages/importers/src/index.ts'),
      '@linkedin-mcp/linkedin': r('./packages/linkedin/src/index.ts'),
      '@linkedin-mcp/server/dashboard': r('./linkedin-mcp-server/src/dashboardBridge.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Environment stays 'node'. DOM tests opt in per file with a
    // `@vitest-environment happy-dom` docblock, so the ~30 server suites do not
    // pay for a DOM they never touch.
    // DB and process-spawning tests are I/O-bound; keep the default pool but
    // give slow Windows CI room.
    testTimeout: 30000,
    // Several suites spawn OS processes: PowerShell for every DPAPI call, node
    // children for the WAL-contention and eval harnesses. Unbounded file
    // parallelism stampedes them and produces timeouts that look like logic
    // failures but are not. Capping the workers keeps the suite honest.
    maxWorkers: 4,

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Everything shipped or importable. Config files, build output and the
      // test tree itself are not the subject.
      include: [
        'packages/*/src/**/*.ts',
        'linkedin-mcp-server/src/**/*.ts',
        'linkedin-dashboard/src/**/*.{ts,tsx}',
        'scripts/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        // Type-only barrels re-export; there is no behaviour to cover.
        '**/index.ts',
        // Pure type declarations. These transpile to an empty module, so v8
        // reports every line as uncovered and no test could ever change that.
        // Verified by hand: 278 declarations, zero runtime statements.
        'linkedin-dashboard/src/client/lib/types.ts',
      ],
      all: true,
    },
  },
});
