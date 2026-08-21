import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build, type Options } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import clientConfig from '../../linkedin-dashboard/tsup.client.config.ts';

// Builds the real browser client and inspects the output.
//
// It builds rather than reading a pre-existing dist/, so `npm test` stays
// self-contained on a fresh clone and so the build itself is under test — the
// asset pipeline is load-bearing now, and a bundle that fails to emit is a
// dashboard that refuses to start.
//
// The tsup config is imported rather than restated, so these assertions are
// made against the same settings that ship.

const dashboardDir = fileURLToPath(new URL('../../linkedin-dashboard/', import.meta.url));

let outDir: string;
const read = (name: string) => readFileSync(join(outDir, name), 'utf8');
const gzipBytes = (name: string) => gzipSync(readFileSync(join(outDir, name))).length;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-bundle-'));
  const base = clientConfig as Options;
  // Entry paths in the config are relative to linkedin-dashboard; the suite runs at
  // the repo root.
  const entry = Object.fromEntries(
    Object.entries(base.entry as Record<string, string>).map(([name, path]) => [
      name,
      join(dashboardDir, path),
    ]),
  );
  await build({ ...base, entry, outDir, clean: true, silent: true, watch: false });
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('dashboard client bundle', () => {
  it('emits every asset the shell references, stylesheet included', () => {
    // The CSS arrives via a side-effect import in main.tsx. If esbuild ever
    // stops emitting it, the shell would link a stylesheet that 404s and the
    // page would render unstyled rather than fail — so this is worth pinning.
    expect(read('app.js').length).toBeGreaterThan(0);
    expect(read('app.css')).toContain('--surface-1');
    expect(read('theme-boot.js').length).toBeGreaterThan(0);
  });

  it('keeps theme-boot loadable as a classic script', () => {
    // It runs synchronously in <head> to prevent a theme flash, which a module
    // script cannot do (modules are always deferred). A classic script with a
    // top-level export or import is a syntax error, so the bundle must have
    // inlined everything it needs.
    const themeBoot = read('theme-boot.js');
    expect(themeBoot).not.toMatch(/(^|[;\s])export[\s{]/);
    expect(themeBoot).not.toMatch(/(^|[;\s])import[\s({]/);
    expect(themeBoot).toContain('linkedin_mcp.theme');
  });

  it('bundles every dependency instead of resolving anything at runtime', () => {
    // Local-first: the page must work with no network at all, and the CSP
    // allows no origin but 'self'. A surviving bare specifier would mean the
    // browser was expected to fetch something.
    const app = read('app.js');
    expect(app).not.toMatch(/from\s*["']hono/);
    expect(app).not.toMatch(/import\s*\(\s*["'][^./]/);
  });

  it('loads no remote asset from CSS', () => {
    // This is the one that actually fetches: url(), @import and @font-face in
    // a stylesheet all issue requests. Nothing absolute belongs here.
    expect(read('app.css')).not.toMatch(/https?:\/\//);
  });

  it('references no unreviewed origin', () => {
    // A string is not a request — the runtime guarantee is the CSP, which
    // allows no origin but 'self' for scripts, styles, images, fonts and
    // connections alike. This is the review gate on top of it: every distinct
    // origin that appears in the bundle at all has to be one somebody
    // deliberately allowed.
    const ALLOWED: Record<string, string> = {
      'http://www.w3.org':
        'XML namespace identifiers, passed to createElementNS for SVG and MathML by hono/jsx. Never fetched.',
      'https://www.linkedin.com':
        'Placeholder and help text in the publication reconciliation form. Never fetched; the domain also validates pasted URLs against it.',
    };

    const origins = new Set(
      (read('app.js').match(/https?:\/\/[^"'`\s)]+/g) ?? []).map(
        (url) => new URL(url.replace(/[$`].*$/, '')).origin,
      ),
    );
    for (const origin of origins) {
      expect(ALLOWED[origin], `unreviewed origin in the bundle: ${origin}`).toBeDefined();
    }
  });

  it('stays inside the performance budget', () => {
    // Budgets from the redesign plan: 60KB gzip JS, 16KB gzip CSS. Recorded at
    // P0: 7.1KB / 1.1KB / 0.2KB.
    expect(gzipBytes('app.js')).toBeLessThan(60 * 1024);
    expect(gzipBytes('app.css')).toBeLessThan(16 * 1024);
    expect(gzipBytes('theme-boot.js')).toBeLessThan(2 * 1024);
  });
});
