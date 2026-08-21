import { defineConfig } from 'tsup';

// The browser bundle. Two entries, because theme-boot must run synchronously in
// <head> before first paint while the app is deferred — and neither may be
// inline, since the new surface ships a strict CSP with no 'unsafe-inline'.
//
// platform:'browser' is load-bearing beyond output format: it makes any
// accidental `node:*` import in client code a build failure, which is the real
// guard against server code drifting into the bundle.
export default defineConfig({
  entry: {
    app: 'src/client/main.tsx',
    'theme-boot': 'src/client/theme-boot.ts',
  },
  outDir: 'dist/client',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  // One file per entry. Shared chunks would need extra asset routes and buy
  // nothing at this size.
  splitting: false,
  clean: true,
  minify: true,
  sourcemap: true,
  // Nothing is fetched at runtime: the CSP allows no origin but 'self', and the
  // product is local-first. Everything, hono included, is bundled in.
  noExternal: [/.*/],
  esbuildOptions(options) {
    options.jsx = 'automatic';
    options.jsxImportSource = 'hono/jsx/dom';
    // Legal comments would otherwise be emitted into a separate .txt file that
    // nothing serves.
    options.legalComments = 'none';
  },
});
