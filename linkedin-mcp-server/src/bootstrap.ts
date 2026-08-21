import { join } from 'node:path';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  purgeEverything,
  runRetentionSweep,
  seedCanonicalSections,
  seedCapabilities,
} from '@linkedin-mcp/domain';
import { resolveDataHome } from '@linkedin-mcp/shared';
import { logInfo } from './log.ts';

export interface AppContext {
  db: SqliteDriver;
  fts5: boolean;
  home: string;
  /** Identifies which surface invoked a shared tool handler. */
  actor: 'mcp_host' | 'dashboard';
  /** Schedules full-home deletion after the current tool response can be sent. */
  scheduleFullPurge?: () => void;
}

export function contextActor(ctx: AppContext): 'mcp_host' | 'dashboard' {
  return ctx.actor;
}

// Data lives under %LOCALAPPDATA%\linkedin-mcp by default — deliberately
// outside OneDrive-synced folders (a cloud agent copying a live WAL database
// is a real corruption/leak vector). Overridable for tests and portable use.
export function bootstrap(): AppContext {
  const home = resolveDataHome();
  const { db, fts5 } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  const { applied } = migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);
  const sweep = runRetentionSweep(db);
  logInfo(
    `boot: home=${home} fts5=${fts5} migrations_applied=[${applied.join(',')}] swept_handles=${sweep.state_handles_removed}`,
  );
  if (!fts5) {
    logInfo('boot: FTS5 unavailable — search degrades to LIKE (safety paths unaffected)');
  }
  let purgeScheduled = false;
  return {
    db,
    fts5,
    home,
    actor: 'mcp_host',
    scheduleFullPurge: () => {
      if (purgeScheduled) return;
      purgeScheduled = true;
      setTimeout(() => {
        db.close();
        const result = purgeEverything(home, 'DELETE ALL LOCAL DATA');
        logInfo(`full purge complete: removed=[${result.removed.join(',')}]`);
        process.exit(0);
      }, 500);
    },
  };
}
