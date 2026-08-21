import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ArtifactStore, migrate, openDatabase } from '@linkedin-mcp/db';
import {
  createSecretStore,
  probeLane,
  resolveDashboardPort,
  runRetentionSweep,
  seedCanonicalSections,
  seedCapabilities,
} from '@linkedin-mcp/domain';
import { resolveDataHome } from '@linkedin-mcp/shared';
import { createDashboardToolCatalog } from '@linkedin-mcp/server/dashboard';
import { DashboardAuth } from './auth.ts';
import { buildDashboardApp } from './app.ts';
import { createAssetProvider, MissingClientBuildError } from './assets.ts';
import { performFullPurge } from './routes/system.ts';

const home = resolveDataHome();
const { db, fts5 } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
migrate(db);
seedCapabilities(db);
seedCanonicalSections(db);
const sweep = runRetentionSweep(db);
const store = new ArtifactStore(join(home, 'artifacts'));
let purgeScheduled = false;
let purgeStarted = false;
const scheduleFullPurge = () => {
  if (purgeScheduled) return;
  purgeScheduled = true;
  setTimeout(shutdownAndPurge, 50);
};
const tools = createDashboardToolCatalog({
  db,
  fts5,
  home,
  actor: 'dashboard',
  scheduleFullPurge,
});

// One typed resolver is shared with the MCP approval link so the listener,
// Host allowlist, and URL returned to the user cannot drift to different ports.
const port = resolveDashboardPort(db);
const auth = new DashboardAuth(port);

// Resolved from this module, not from cwd: `npm run dashboard` runs in
// linkedin-dashboard while tests run at the repo root, and the dashboard must not
// depend on which one started it.
const clientDir = fileURLToPath(new URL('../dist/client/', import.meta.url));
// tsup rebuilds the client without restarting this process in development, so
// the provider re-reads changed files there. NODE_ENV is unset in the dev
// script; a production-equivalent run sets it to 'production'.
const watchAssets = process.env['NODE_ENV'] !== 'production';

let assets: ReturnType<typeof createAssetProvider>;
try {
  assets = createAssetProvider(clientDir, { watch: watchAssets });
} catch (err) {
  if (err instanceof MissingClientBuildError) {
    // Refusing to start beats serving a blank page: this is the only surface
    // that can approve a publication, and a silently dead one is how the
    // P7-era script bug survived two phases.
    console.error(`[dashboard] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = buildDashboardApp({
  db,
  store,
  fts5,
  home,
  auth,
  secretStore: createSecretStore(db, home),
  probeLane,
  tools,
  assets,
  shutdown: shutdownAndPurge,
});

// The port bind doubles as the single-instance mutex.
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(
    `[dashboard] retention sweep: handles=${sweep.state_handles_removed} claims_expired=${sweep.claims_expired}`,
  );
  console.log('[dashboard] open this URL (token is single-launch, fragment never hits logs):');
  console.log(`\n  http://127.0.0.1:${port}/#t=${auth.launchToken}\n`);
});

function shutdownAndPurge(): void {
  if (purgeStarted) return;
  purgeStarted = true;
  purgeScheduled = true;
  // Full local purge: the response has already gone out. Close the database
  // before deleting <home>/data, because Windows will not remove an open file.
  server.close(() => {
    const result = performFullPurge(home, () => db.close());
    console.error('[dashboard] local data purged:', JSON.stringify(result));
    process.exit(0);
  });
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[dashboard] already running on 127.0.0.1:${port} — use the existing window`);
    process.exit(0);
  }
  console.error('[dashboard]', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
});
