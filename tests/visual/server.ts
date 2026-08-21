import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ArtifactStore, migrate, openDatabase } from '@linkedin-mcp/db';
import { seedCanonicalSections, seedCapabilities } from '@linkedin-mcp/domain';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { createAssetProvider } from '../../linkedin-dashboard/src/assets.ts';
import { seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// An isolated dashboard for the visual suite.
//
// Its own home, its own port, its own fixture corpus — it never touches the
// member's real database, and it makes no network call of any kind. The
// LinkedIn lanes stay unconfigured, so every external capability is exactly
// where it starts: unavailable.

const PORT = Number(process.env['VISUAL_PORT'] ?? 4790);
const HOME = process.env['VISUAL_HOME'];
if (!HOME) throw new Error('VISUAL_HOME must point at a scratch directory');

rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, 'data'), { recursive: true });

const opened = openDatabase(join(HOME, 'data', 'linkedin.sqlite3'));
migrate(opened.db);
seedCapabilities(opened.db);
seedCanonicalSections(opened.db);

const store = new ArtifactStore(join(HOME, 'artifacts'));
const fixture: Fixture = {
  dir: HOME,
  db: opened.db,
  store,
  fts5: opened.fts5,
  close: () => opened.db.close(),
};
seedHealthy(fixture);

const auth = new DashboardAuth(PORT);
const app = buildDashboardApp({
  db: opened.db,
  store,
  fts5: opened.fts5,
  home: HOME,
  auth,
  assets: createAssetProvider(
    fileURLToPath(new URL('../../linkedin-dashboard/dist/client/', import.meta.url)),
  ),
});

// The launch token is single-use, so it is handed to the suite through a file
// rather than scraped from stdout — one exchange, then reused as a stored
// session for every browser context.
writeFileSync(
  join(HOME, 'launch.json'),
  JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: auth.launchToken }),
);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, () => {
  console.log(`[visual] seeded dashboard on http://127.0.0.1:${PORT}`);
});
