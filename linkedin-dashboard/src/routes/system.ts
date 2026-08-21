import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  configureLane,
  disablePublishing,
  enablePublishing,
  exportBundle,
  listBackups,
  listCapabilities,
  listFeatureControls,
  getFeatureControl,
  listLanes,
  listObservations,
  metricsSummary,
  purgeArtifact,
  purgeEverything,
  queryAuditEvents,
  resolveBackupDir,
  retentionSummary,
  runBackup,
  verifyAuditChain,
  verifyBackup,
  verifyLane,
  FEATURE_KEYS,
  setFeatureControl,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { confirmedBody, page, type ApiDeps } from './types.ts';

// Credentials, capabilities, retention, analytics, the audit log, and the
// local-data operations.

const FULL_PURGE_PHRASE = 'DELETE ALL LOCAL DATA';

export function systemRoutes(deps: ApiDeps): Hono {
  const { db } = deps;
  const api = new Hono();

  api.get('/system', (c) =>
    c.json({
      capabilities: listCapabilities(db),
      features: listFeatureControls(db),
      retention: retentionSummary(db),
      lanes: listLanes(db),
    }),
  );

  // Its own endpoint, off the critical path.
  //
  // verifyAuditChain re-hashes every row in the log, and the Overview is now
  // the landing screen — so putting it inline would make every visit pay for
  // the whole history. Making it cheaper by caching or sampling is not an
  // option: this check is what stands between a tampered log and an approval,
  // and a bounded version that reported "intact" would be a lie.
  api.get('/system/chain', (c) => c.json({ chain: verifyAuditChain(db) }));

  api.get('/audit', (c) => {
    const { limit, offset } = page(c);
    const filters: Parameters<typeof queryAuditEvents>[1] = { limit: limit + offset };
    const eventType = c.req.query('event_type');
    if (eventType) filters.event_type = eventType;
    const subjectId = c.req.query('subject_id');
    if (subjectId) filters.subject_id = subjectId;
    const since = c.req.query('since');
    if (since) filters.since = since;

    // One extra row is the probe: if it comes back, there is a next page. The
    // previous `rows.length >= limit + offset` claimed one whenever the window
    // was exactly full, which is precisely when there is nothing more.
    const rows = queryAuditEvents(db, { ...filters, limit: limit + offset + 1 });
    const window = rows.slice(offset, offset + limit);
    return c.json({ events: window, has_more: rows.length > offset + window.length });
  });

  api.get('/analytics', (c) => {
    const { limit, offset } = page(c);
    return c.json({
      metrics: listObservations(db, { limit, offset }),
      summary: metricsSummary(db),
    });
  });

  // --- credentials: explicit human entry point --------------------------
  // No MCP tool can reach this: linkedin_settings_set refuses secret-shaped
  // keys. The companion CLI is the equivalent human-only path. The value is
  // encrypted on arrival and never read back out to any response.
  api.post('/lanes/:lane/token', async (c) => {
    const lane = c.req.param('lane');
    if (lane !== 'read' && lane !== 'write') {
      throw new DomainError('INVALID_INPUT', 'lane must be read or write');
    }
    if (!deps.secretStore) {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        'secret storage is unavailable on this platform',
      );
    }
    const body = await confirmedBody<{
      client_id?: string;
      access_token?: string;
      expires_in_seconds?: number;
    }>(c);
    const account = await configureLane(db, deps.secretStore, {
      lane,
      client_id: body.client_id ?? '',
      access_token: body.access_token ?? '',
      ...(body.expires_in_seconds !== undefined
        ? { expires_in_seconds: body.expires_in_seconds }
        : {}),
    });
    return c.json({ account });
  });

  api.post('/lanes/:lane/verify', async (c) => {
    const lane = c.req.param('lane');
    if (lane !== 'read' && lane !== 'write') {
      throw new DomainError('INVALID_INPUT', 'lane must be read or write');
    }
    if (!deps.secretStore || !deps.probeLane) {
      throw new DomainError('CAPABILITY_UNAVAILABLE', 'live verification is unavailable');
    }
    await confirmedBody(c);
    const result = await verifyLane(
      db,
      deps.secretStore,
      lane,
      (token) => deps.probeLane!(lane, token),
      'dashboard',
    );
    return c.json({ result });
  });

  api.post('/capabilities/publishing/enable', async (c) => {
    await confirmedBody(c);
    const result = enablePublishing(db, true);
    const feature = setFeatureControl(db, 'live_publishing', true, {
      confirm: true,
      actor: 'dashboard',
    });
    return c.json({ result, feature });
  });

  api.post('/features/:key', async (c) => {
    const key = c.req.param('key');
    if (!(FEATURE_KEYS as readonly string[]).includes(key)) {
      throw new DomainError('INVALID_INPUT', `unknown feature '${key}'`);
    }
    const body = await confirmedBody<{ enabled?: boolean }>(c);
    if (typeof body.enabled !== 'boolean') {
      throw new DomainError('INVALID_INPUT', 'enabled must be a boolean');
    }
    const featureKey = key as (typeof FEATURE_KEYS)[number];
    const current = getFeatureControl(db, featureKey);
    if (current.enabled === body.enabled) return c.json({ feature: current });
    if (featureKey === 'live_publishing') {
      if (body.enabled) enablePublishing(db, true, 'dashboard');
      else disablePublishing(db, true, 'dashboard');
    }
    return c.json({
      feature: setFeatureControl(db, featureKey, body.enabled, {
        confirm: true,
        actor: 'dashboard',
      }),
    });
  });

  // --- local data operations -------------------------------------------

  api.get('/backups', (c) => {
    if (!deps.home) throw new DomainError('CAPABILITY_UNAVAILABLE', 'no data home configured');
    return c.json({ backups: listBackups(deps.home) });
  });

  api.post('/backups', async (c) => {
    if (!deps.home) throw new DomainError('CAPABILITY_UNAVAILABLE', 'no data home configured');
    const body = await confirmedBody<{ label?: string }>(c);
    // No path parameter, ever: backups only land in the managed location.
    return c.json({
      backup: await runBackup(db, deps.home, {
        ...(body.label ? { label: body.label } : {}),
        actor: 'dashboard',
      }),
    });
  });

  // By name, resolved against the listing — never by a caller-supplied path.
  api.post('/backups/:name/verify', async (c) => {
    if (!deps.home) throw new DomainError('CAPABILITY_UNAVAILABLE', 'no data home configured');
    await confirmedBody(c);
    const directory = resolveBackupDir(deps.home, c.req.param('name'));
    if (!directory) throw new DomainError('NOT_FOUND', 'no such backup');
    return c.json({ result: verifyBackup(directory) });
  });

  api.get('/export-bundle', (c) => c.json({ bundle: exportBundle(db) }));

  // Irreversible. The domain refuses while any live claim cites the artifact,
  // and the client lists those claims rather than reporting a bare failure.
  api.post('/artifacts/:id/purge', async (c) => {
    await confirmedBody(c);
    return c.json({ result: purgeArtifact(db, deps.store, c.req.param('id'), true) });
  });

  // Unrecoverable: this deletes the evidence corpus, the artifact store, the
  // backups and the DPAPI-wrapped master key, which makes any stray ciphertext
  // permanently undecryptable.
  //
  // The ordering below is not incidental. purgeEverything removes <home>/data
  // while this process holds the SQLite file open, and Windows refuses to
  // delete an open file — so the response goes out first, then the database is
  // closed, then the deletion runs, and the process ends. Partial failure is
  // reported as partial failure; success is never claimed for directories that
  // are still there.
  api.post('/purge-all', async (c) => {
    if (!deps.home) throw new DomainError('CAPABILITY_UNAVAILABLE', 'no data home configured');
    const body = await c.req
      .json<{ confirm_phrase?: string; accept_no_backup?: boolean }>()
      .catch((): { confirm_phrase?: string; accept_no_backup?: boolean } => ({}));
    if (body.confirm_phrase !== FULL_PURGE_PHRASE) {
      throw new DomainError(
        'INVALID_INPUT',
        `full purge requires confirm_phrase to be exactly "${FULL_PURGE_PHRASE}"`,
        { blockers: ['confirmation_required'] },
      );
    }
    if (!deps.shutdown) {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        'full purge needs a shutdown hook; it is not available in this context',
      );
    }
    const hasVerifiedBackup = listBackups(deps.home).some((backup) => {
      try {
        const directory = resolveBackupDir(deps.home!, backup.name);
        return directory !== null && verifyBackup(directory).valid;
      } catch {
        return false;
      }
    });
    if (!hasVerifiedBackup && body.accept_no_backup !== true) {
      throw new DomainError(
        'INVALID_INPUT',
        'no verified backup exists; verify one first, or explicitly accept permanent loss',
        { blockers: ['verified_backup_required'] },
      );
    }
    // Scheduled after the response is written. deps.shutdown closes the
    // database, runs the purge, and exits.
    setTimeout(deps.shutdown, 50);
    return c.json({
      status: 'purging',
      message:
        'All local data is being deleted and this server is shutting down. This window is no longer connected to anything.',
    });
  });

  return api;
}

/**
 * Runs the deletion after the server has let go of the database.
 *
 * Exported so server.ts can supply it and tests can drive it against an
 * isolated home without going through HTTP.
 */
export function performFullPurge(
  home: string,
  closeDb: () => void,
): { removed: string[]; absent: string[]; remaining: string[] } {
  closeDb();
  const { removed, kept } = purgeEverything(home, FULL_PURGE_PHRASE);
  // Checked rather than assumed. purgeEverything's `kept` means "was not there
  // to begin with"; what actually matters is whether anything it tried to
  // delete is STILL there — a partial deletion on Windows is the failure this
  // ordering exists to avoid, and reporting it as success would be the worst
  // possible outcome.
  const remaining = removed.filter((dir) => existsSync(join(home, dir)));
  return { removed: removed.filter((dir) => !remaining.includes(dir)), absent: kept, remaining };
}
