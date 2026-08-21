import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  // Bundled CommonJS deps (yauzl) call require(); ESM output needs the shim.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  // Workspace packages ship TypeScript sources; bundle them into the app.
  noExternal: [/^@linkedin-mcp\//],
  // node:* must be listed explicitly: this esbuild's builtin list predates
  // node:sqlite and would otherwise rewrite it to a bare 'sqlite' import.
  external: ['@modelcontextprotocol/server', 'zod', /^node:/],
});
