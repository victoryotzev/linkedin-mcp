# Architecture

Two surfaces, one engine, one local database. This document explains the seams
that are not obvious from the directory listing.

## Shape

```
             ┌──────────────────────┐        ┌────────────────────────┐
   AI host ──│  linkedin-mcp-server │        │  linkedin-dashboard    │──  browser
   (stdio)   │  44 tools, 5 res,    │        │  loopback HTTP, 6      │    (127.0.0.1)
             │  5 prompts           │        │  screens + tool console│
             └──────────┬───────────┘        └───────────┬────────────┘
                        │                                │
                        └───────────┬────────────────────┘
                                    │
                        ┌───────────┴────────────┐
                        │   packages/domain      │  evidence, claims, profile,
                        │   (all business logic) │  drafts, approvals, audit
                        └───────────┬────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
      packages/db            packages/importers     packages/linkedin
      SQLite, migrations     ZIP/CSV/PDF/repo       OIDC, DMA, publishing
      artifact store         path guard, redaction  (fail-closed)
                                    │
                        packages/shared  — canonical JSON, ids, errors, data home
```

The dashboard is **not** a second implementation. It is an HTTP shell over the
same domain services and the same tool registry the MCP server exposes
(`linkedin-dashboard/src/app.ts:57-60`), which is why **System → All MCP tools**
can render every registered operation without a parallel code path.

## Load-bearing seams

### The tool registry is SDK-neutral

Tools are declared against a plain interface, and exactly one adapter binds that
registry to the MCP SDK (`linkedin-mcp-server/src/registry.ts:3-5`). If the SDK
has to change, only the adapter moves.

`validateToolRegistry` refuses a tool that omits any of the four annotation
hints, or that claims to be both read-only and destructive
(`linkedin-mcp-server/src/registry.ts:47-66`). The spec's defaults are
pessimistic, so omission is never treated as intent.

### The database driver is a seam

Nothing outside `packages/db` touches `node:sqlite`. The driver is acquired
through `process.getBuiltinModule` rather than a static import, because
esbuild's builtin list predates `node:sqlite` and would rewrite it to a bare
`sqlite` package when bundling (`packages/db/src/driver.ts:2-9`). If
`node:sqlite` ever becomes unusable, an alternative slots in behind
`SqliteDriver` without domain code changing
(`packages/db/src/driver.ts:11-13`).

Every process opens the database through one function so pragma discipline is
identical everywhere: WAL, `busy_timeout`, foreign keys on, `trusted_schema`
off (`packages/db/src/open.ts:9-20`).

### One data home, resolved one way

`resolveDataHome()` is the single resolver used by the MCP server, the
dashboard, and the control CLI (`packages/shared/src/dataHome.ts:16-40`). It
requires an absolute path, because two MCP hosts with different working
directories would otherwise open two different databases while appearing to
share one configuration.

### Migrations are forward-only

Applied at every process start (`linkedin-mcp-server/src/bootstrap.ts:32`).
There are no down-migrations by design; see [releases.md](releases.md).

### Feature gates wrap handlers, not call sites

`toolDefs` wraps each handler in a feature check rather than sprinkling checks
through the tools (`linkedin-mcp-server/src/catalog.ts:16-40`), and the
dashboard applies the same policy to its routes from the same table. One
setting, both surfaces.

## Concurrency

The dashboard and any number of MCP client processes open the same home
simultaneously. WAL mode, immediate write transactions, and bounded busy retries
keep committed progress consistent; `tests/integration/wal-contention.test.ts`
exercises it with real child processes.

The dashboard's port bind doubles as a single-instance mutex
(`linkedin-dashboard/src/server.ts:83-84`).

## Workspace layout, and why nothing is published

| Package | Responsibility |
|---|---|
| `linkedin-mcp-server` | stdio transport, tool/resource/prompt definitions, the SDK adapter |
| `linkedin-dashboard` | loopback HTTP shell, browser client, asset provider |
| `packages/domain` | all business logic |
| `packages/db` | SQLite driver, migrations, artifact store |
| `packages/importers` | ZIP, CSV, PDF, DOCX, repo scanning, path guard, redaction |
| `packages/linkedin` | OIDC, DMA, publishing adapters — all fail-closed |
| `packages/shared` | canonical JSON, identifiers, error contracts, data home |

**These are internal seams, not a published SDK.** Every `packages/*` manifest
points `main` and `exports` at `./src/index.ts` — raw TypeScript — and
`@linkedin-mcp/server` exposes `exports["./dashboard"]` as
`./src/dashboardBridge.ts`. That works because the consumer is always another
workspace compiled by the same toolchain. It would not survive publication: any
publish path needs real build output for those entry points and explicit version
ranges in place of the current `"*"`.

All eight manifests are `"private": true`, and that is deliberate rather than
incidental.

## Build

- **Server** (`linkedin-mcp-server/tsup.config.ts`): bundles the workspace
  packages, externalises `@modelcontextprotocol/server`, `zod` and `node:*`.
  `node:*` is listed explicitly because this esbuild's builtin list predates
  `node:sqlite`. A `createRequire` banner exists because bundled CommonJS
  dependencies call `require()`.
- **Client** (`linkedin-dashboard/tsup.client.config.ts`): two entries, because
  the theme bootstrap must run synchronously in `<head>` before first paint
  while the app is deferred — and neither may be inline, since the surface ships
  a strict CSP with no `unsafe-inline`. `platform: 'browser'` is load-bearing
  beyond output format: it turns an accidental `node:*` import in client code
  into a build failure.

### Dependency pinning

The root manifest carries `overrides.esbuild`, which forces one esbuild version
across the tree regardless of what `tsup` resolves. `package.json` is strict
JSON and cannot hold a comment explaining that, so it is recorded here.

`pdfjs-dist` is deliberately **not** bundled. PDF parsing runs in a child
process that imports it at runtime (`packages/importers/scripts/pdf-extract.mjs:11`),
which is what lets the parent enforce a hard timeout and byte cap.

## Where to start reading

| Question | File |
|---|---|
| What tools exist? | `linkedin-mcp-server/src/catalog.ts` |
| How is a tool defined? | `linkedin-mcp-server/src/registry.ts` |
| What happens at startup? | `linkedin-mcp-server/src/bootstrap.ts` |
| How is publishing gated? | `linkedin-mcp-server/src/tools/publish.ts` |
| How is the audit chain built? | `packages/domain/src/auditService.ts` |
| How are paths made safe? | `packages/importers/src/pathGuard.ts` |
| How are credentials stored? | `packages/domain/src/secretStore.ts` |
| How does the dashboard authenticate? | `linkedin-dashboard/src/auth.ts` |
