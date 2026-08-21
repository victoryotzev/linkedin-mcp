import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { createHash } from 'node:crypto';
import { canonicalJson, DomainError, newId, type Jsonish } from '@linkedin-mcp/shared';
import { appendAuditEvent } from './auditService.ts';
import type { AuditActor } from './auditService.ts';
import { requireCapability } from './capabilityService.ts';
import {
  isValidEventTimestamp,
  newestValidProcessedAt,
  normalizeChangelogElement,
  readProfileChangelogState,
} from './dmaChangelogEvents.ts';
import {
  DEFAULT_SNAPSHOT_DOMAINS,
  PROFILE_SNAPSHOT_DOMAINS,
  isProfileSnapshotDomain,
  fieldKeysForDomain,
  observeFailure,
  observeRows,
  type DomainObservation,
  type DomainObservationStatus,
  type ProfileSnapshotDomain,
} from './dmaProfileDomains.ts';
import { recordObservation, setObservationFreshness } from './dmaObservationService.ts';
import {
  PROFILE_CHANGELOG_RESOURCES,
  analyzeProfileFreshness,
  type ProfileFreshnessReport,
} from './profileFreshnessService.ts';

// The EU Data Portability read lane.
//
// Every refresh here happens because someone invoked a tool; this repository
// contains no scheduler and this change did not add one. That is a product
// choice, not a legal one: LinkedIn's Portability API terms say what may be
// stored and for how long, and forbid obtaining data outside the Portability
// APIs, but they place no prohibition on refreshing on a cadence — LinkedIn's
// own Changelog guidance actually recommends "querying each member's activities
// once an hour". An earlier comment here claimed the opposite; it was wrong.
//
// The Changelog serves a rolling 28-day window, which is why every row is
// persisted the moment it arrives — anything not stored locally is gone. The
// fetch cursor is LinkedIn's documented one: the latest returned processedAt,
// replayed inclusively on the next request and deduplicated locally.

// A client that can fetch DMA data. Declared here as a port so the domain never
// imports a concrete HTTP client, and tests can drive the mapping without a
// network.
export interface DmaSource {
  assertDomainAllowed(domain: string): void;
  fetchSnapshotDomain(
    domain: string,
  ): Promise<{ domain: string; rows: Array<Record<string, unknown>> }>;
}

export interface DmaChangelogSource {
  fetchChangelog(sinceMs: number): Promise<Array<Record<string, unknown>>>;
}

export interface DmaChangelogSyncReport {
  window_start_ms: number;
  /**
   * Local wall-clock of this sync. Diagnostics only: it used to be written as
   * the fetch cursor, which is the defect this replaced.
   */
  watermark_ms: number;
  /** The inclusive startTime the next sync will use; null until one is known. */
  cursor_ms: number | null;
  cursor_advanced: boolean;
  newest_processed_at_ms: number | null;
  events_without_processed_at: number;
  rows_fetched: number;
  imported: number;
  duplicates: number;
  synced_at: string;
}

// The full window LinkedIn retains. Asking for more is safe — the documentation
// states that a startTime older than 28 days simply returns events up to 28
// days — so there is no reason to leave the oldest day unread, which a 27-day
// window did whenever a sync followed a long gap.
const CHANGELOG_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const CHANGELOG_OVERLAP_MS = 5 * 60 * 1000;

// Fetch first, then atomically persist every event and move the cursor.
//
// The cursor is LinkedIn's: "specify startTime by using the latest processedAt
// from the previous response. If there is no event from the previous response,
// keep the same startTime." It is inclusive, so the newest event comes back
// once more and is discarded by the canonical-payload hash. The extra five
// minutes only ever asks for more than that, which is free for the same reason
// and covers an event whose processedAt lands just under the boundary.
//
// The cursor never moves on an empty response, never moves without a usable
// processedAt, never moves backwards, and never moves at all when the fetch,
// the pagination walk or the transaction fails.
export async function syncChangelogFromDma(
  db: SqliteDriver,
  client: DmaChangelogSource,
  opts: { now?: Date; actor?: AuditActor } = {},
): Promise<DmaChangelogSyncReport> {
  requireCapability(db, 'linkedin.dma_changelog');
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const state = db.get(
    `SELECT processed_at_cursor_ms, cursor_repaired
       FROM dma_changelog_watermarks WHERE lane = 'member'`,
  );
  const oldestAvailable = Math.max(0, nowMs - CHANGELOG_WINDOW_MS);
  const storedCursor =
    state && state['processed_at_cursor_ms'] !== null
      ? Number(state['processed_at_cursor_ms'])
      : null;
  // Migration 017 seeded the cursor from the events already on disk. That seed
  // is trusted for ordering but not for coverage: the first sync after the
  // repair re-reads the whole retained window once, so a seed that landed too
  // high cannot silently skip events LinkedIn will never serve again.
  const repairPending = state !== undefined && Number(state['cursor_repaired']) === 1;
  const windowStart =
    storedCursor === null || repairPending
      ? oldestAvailable
      : Math.max(oldestAvailable, storedCursor - CHANGELOG_OVERLAP_MS);

  const rows = await client.fetchChangelog(windowStart);

  const newestProcessedAt = newestValidProcessedAt(rows, nowMs);
  const nextCursor =
    newestProcessedAt === null
      ? storedCursor
      : Math.max(storedCursor ?? Number.NEGATIVE_INFINITY, newestProcessedAt);
  const cursorAdvanced = nextCursor !== storedCursor;
  const eventsWithoutProcessedAt = rows.filter(
    (row) => !isValidEventTimestamp(row['processedAt'], nowMs),
  ).length;

  return withWriteTx(db, () => {
    let imported = 0;
    for (const row of rows) {
      const eventJson = canonicalJson(row as Jsonish);
      const eventHash = createHash('sha256').update(eventJson, 'utf8').digest('hex');
      const normalized = normalizeChangelogElement(row, nowMs);
      // OR IGNORE, not OR REPLACE: the raw history is append-only. A replay of
      // the same activity arrives with a different activityStatus, so it hashes
      // differently and lands as its own row rather than overwriting the
      // failure that preceded it.
      const inserted = db.run(
        `INSERT OR IGNORE INTO dma_changelog_events
         (event_hash, event_json, requested_since_ms, received_at, retention_class,
          upstream_event_id, activity_id, resource_name, resource_id, method,
          captured_at_ms, processed_at_ms, config_version, activity_status)
         VALUES (?, ?, ?, ?, 'durable_dma', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventHash,
        eventJson,
        windowStart,
        now.toISOString(),
        normalized.upstream_event_id,
        normalized.activity_id,
        normalized.resource_name,
        normalized.resource_id,
        normalized.method,
        normalized.captured_at_ms,
        normalized.processed_at_ms,
        normalized.config_version,
        normalized.activity_status,
      );
      imported += Number(inserted.changes);
    }
    db.run(
      `INSERT INTO dma_changelog_watermarks
       (lane, watermark_ms, last_window_start_ms, last_synced_at, last_rows_fetched,
        last_rows_imported, processed_at_cursor_ms, cursor_repaired)
       VALUES ('member', ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (lane) DO UPDATE SET
         watermark_ms = excluded.watermark_ms,
         last_window_start_ms = excluded.last_window_start_ms,
         last_synced_at = excluded.last_synced_at,
         last_rows_fetched = excluded.last_rows_fetched,
         last_rows_imported = excluded.last_rows_imported,
         processed_at_cursor_ms = excluded.processed_at_cursor_ms,
         cursor_repaired = 0`,
      nowMs,
      windowStart,
      now.toISOString(),
      rows.length,
      imported,
      nextCursor,
    );
    db.run(
      `INSERT INTO dma_sync_state (domain, last_synced_at, last_watermark_ms, rows_imported, note)
       VALUES ('CHANGELOG', ?, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET last_synced_at = excluded.last_synced_at,
         last_watermark_ms = excluded.last_watermark_ms,
         rows_imported = excluded.rows_imported, note = excluded.note`,
      now.toISOString(),
      nextCursor,
      imported,
      `${rows.length - imported} duplicate event(s); next startTime ${nextCursor ?? '(full window)'}`,
    );
    appendAuditEvent(db, {
      event_type: 'dma.changelog_sync',
      actor: opts.actor ?? 'mcp_host',
      subject_type: 'dma_changelog',
      // Counts and timestamps only. No resource identifiers and no activity
      // payloads: the changelog carries messages and invitations too, and the
      // audit log is exportable.
      payload: {
        window_start_ms: windowStart,
        watermark_ms: nowMs,
        cursor_ms: nextCursor,
        cursor_advanced: cursorAdvanced,
        cursor_repair_window_used: repairPending,
        events_without_processed_at: eventsWithoutProcessedAt,
        rows_fetched: rows.length,
        imported,
        duplicates: rows.length - imported,
        session_triggered: true,
      },
    });
    return {
      window_start_ms: windowStart,
      watermark_ms: nowMs,
      cursor_ms: nextCursor,
      cursor_advanced: cursorAdvanced,
      newest_processed_at_ms: newestProcessedAt,
      events_without_processed_at: eventsWithoutProcessedAt,
      rows_fetched: rows.length,
      imported,
      duplicates: rows.length - imported,
      synced_at: now.toISOString(),
    };
  });
}

export interface DomainSyncResult {
  domain: string;
  rows_fetched: number;
  imported: number;
  skipped: number;
  status: DomainObservationStatus;
  failure_reason?: string;
  /** Observation whose rendering was reused because this read had none. */
  carried_forward_from?: string;
  note?: string;
}

export interface DmaObservationSummary {
  id: string;
  snapshot_created: boolean;
  requested_at: string;
  request_completed_at: string;
  observed_at: string;
  content_fingerprint: string;
  content_identical_to_previous: boolean;
}

export interface DmaSyncReport {
  snapshot_id: string | null;
  domains: DomainSyncResult[];
  posts_imported: number;
  synced_at: string;
  observation: DmaObservationSummary;
  freshness: ProfileFreshnessReport;
}

export interface DmaSyncOptions {
  domains?: readonly string[];
  now?: Date;
  actor?: AuditActor;
  locale?: string;
}

/**
 * Snapshot-side sync. Fetches the requested domains, records what each one
 * actually did, and answers with a freshness verdict rather than a bare id.
 *
 * The default domain set is every profile domain plus own post history — see
 * DEFAULT_SNAPSHOT_DOMAINS, which is pinned by a test because each domain is a
 * separate paginated walk and that list is therefore also the latency and
 * rate-limit budget. Pass `domains` to narrow it.
 */
export async function syncFromDma(
  db: SqliteDriver,
  client: DmaSource,
  opts: DmaSyncOptions = {},
): Promise<DmaSyncReport> {
  // Fails closed while no LinkedIn app is verified; the gate runs before any
  // network call is attempted.
  requireCapability(db, 'linkedin.dma_snapshot');

  const now = opts.now ?? new Date();
  // Deduplicated: a repeated name would fetch the domain twice and then fail
  // the per-observation primary key AFTER every upstream request had been made.
  const wanted = [...new Set(opts.domains ?? DEFAULT_SNAPSHOT_DOMAINS)];
  for (const domain of wanted) client.assertDomainAllowed(domain);

  const observations = await fetchDomains(client, wanted);
  const completedAt = opts.now ?? new Date();

  return withWriteTx(db, () =>
    persistObservation(db, {
      requestedDomains: wanted,
      observations,
      requestedAt: now,
      requestCompletedAt: completedAt,
      observedAt: completedAt,
      actor: opts.actor ?? 'mcp_host',
      auditEventType: 'dma.sync',
      ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    }),
  );
}

export interface ProfileReadLatestOptions {
  /** Defaults to every profile domain. Content domains are not accepted here. */
  domains?: readonly ProfileSnapshotDomain[];
  /** Reconcile the Changelog before reading the Snapshot. Default true. */
  syncChangelog?: boolean;
  locale?: string;
  now?: Date;
  actor?: AuditActor;
}

export interface ProfileReadLatestResult {
  /**
   * The effective observed profile: what this Snapshot read rendered, with any
   * domain LinkedIn could not answer carried forward from the last observation
   * that did — every such domain named in freshness.domains.carried_forward.
   */
  observed: Record<string, string>;
  snapshot_id: string | null;
  observation: DmaObservationSummary;
  domains: DomainSyncResult[];
  /** null when the caller skipped the changelog step, or when it failed. */
  changelog: DmaChangelogSyncReport | null;
  /** Why the changelog step failed, when it did. The Snapshot read continues. */
  changelog_error: string | null;
  freshness: ProfileFreshnessReport;
}

/**
 * One live read of the member's own profile through the portability lane.
 *
 * Always talks to LinkedIn — it never answers from the newest stored snapshot,
 * which is the whole point of it existing next to linkedin_profile_get. What it
 * cannot do is promise the answer is current: the Changelog is reconciled first
 * precisely so the result can say when LinkedIn's own Snapshot is behind its own
 * Changelog, and that is the strongest claim either API supports.
 *
 * Canonical sections are never touched. This writes an observation, and at most
 * a snapshot; what becomes canonical stays a human decision made through
 * linkedin_profile_update.
 */
export async function readLatestProfileFromDma(
  db: SqliteDriver,
  client: DmaSource & DmaChangelogSource,
  opts: ProfileReadLatestOptions = {},
): Promise<ProfileReadLatestResult> {
  const syncChangelog = opts.syncChangelog ?? true;
  // Both gates run before any adapter work, so a closed lane opens no socket.
  if (syncChangelog) requireCapability(db, 'linkedin.dma_changelog');
  requireCapability(db, 'linkedin.dma_snapshot');

  const wanted: ProfileSnapshotDomain[] = [...new Set(opts.domains ?? PROFILE_SNAPSHOT_DOMAINS)];
  for (const domain of wanted) {
    if (!isProfileSnapshotDomain(domain)) {
      throw new DomainError(
        'INVALID_INPUT',
        `${String(domain)} is not a profile snapshot domain; this read covers profile domains only`,
        { blockers: ['domain_not_a_profile_domain'] },
      );
    }
    client.assertDomainAllowed(domain);
  }

  const requestedAt = opts.now ?? new Date();

  // Changelog first, and to completion. It is what makes lag detectable: the
  // Snapshot response carries no timestamp of its own, so the only evidence
  // that LinkedIn is behind is an event it already recorded.
  //
  // A changelog failure must not take the Snapshot lane down with it. The two
  // are independent upstream calls, and the changelog walk has a failure mode
  // that repeats: a member whose 28-day window holds more than the client's
  // bounded page walk can fetch will fail it identically every time. Letting
  // that propagate meant the profile could not be read at all while the
  // Snapshot lane was perfectly healthy. The failure is reported instead, and
  // it keeps the verdict away from any clean status.
  let changelog: DmaChangelogSyncReport | null = null;
  let changelogError: string | null = null;
  if (syncChangelog) {
    try {
      changelog = await syncChangelogFromDma(db, client, {
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
      });
    } catch (err) {
      // A rejected credential is not a changelog-specific problem: the Snapshot
      // requests would fail the same way, so there is nothing to salvage.
      if (err instanceof DomainError && err.code === 'CAPABILITY_UNAVAILABLE') throw err;
      changelogError = err instanceof Error ? err.message : String(err);
    }
  }

  const observations = await fetchDomains(client, wanted);
  const completedAt = opts.now ?? new Date();

  const report = withWriteTx(db, () =>
    persistObservation(db, {
      requestedDomains: wanted,
      observations,
      requestedAt,
      requestCompletedAt: completedAt,
      observedAt: completedAt,
      actor: opts.actor ?? 'mcp_host',
      auditEventType: 'dma.profile_read',
      ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
      ...(changelogError !== null ? { changelogError } : {}),
    }),
  );

  return {
    observed: report.fields,
    snapshot_id: report.snapshot_id,
    observation: report.observation,
    domains: report.domains,
    changelog,
    changelog_error: changelogError,
    freshness: report.freshness,
  };
}

/**
 * Every network call happens BEFORE anything is written, and the whole
 * persistence phase is then one transaction. Fetching first also keeps a write
 * transaction from being held open across HTTP, which would block every other
 * process for the duration — and withWriteTx re-runs its body on SQLITE_BUSY,
 * so a request issued inside one would be issued again.
 */
async function fetchDomains(
  client: DmaSource,
  domains: readonly string[],
): Promise<DomainObservation[]> {
  const observations: DomainObservation[] = [];
  for (const domain of domains) {
    try {
      const page = await client.fetchSnapshotDomain(domain);
      observations.push(observeRows(domain, page.rows));
    } catch (err) {
      // A rejected credential is not a per-domain problem: every remaining
      // domain would fail the same way, so isolating it would spend ten more
      // requests on a dead token and then report the outcome as ten unrelated
      // retryable failures instead of one actionable "re-mint the token".
      if (err instanceof DomainError && err.code === 'CAPABILITY_UNAVAILABLE') throw err;
      // Everything else is isolated per domain. One domain failing used to
      // abort the whole sync and discard every other domain's already-fetched
      // rows, so a single oversized or unavailable domain made the entire
      // profile un-syncable.
      observations.push(observeFailure(domain, err));
    }
  }
  if (
    observations.length > 0 &&
    observations.every((o) => o.status === 'failed' || o.status === 'pagination_incomplete')
  ) {
    throw new DomainError(
      'INTERNAL',
      `every requested domain failed; the first error was: ${observations[0]?.failure_reason ?? 'unknown'}`,
      { blockers: ['dma_sync_failed'], retryable: true },
    );
  }
  return observations;
}

interface PersistObservationInput {
  requestedDomains: readonly string[];
  observations: readonly DomainObservation[];
  requestedAt: Date;
  requestCompletedAt: Date;
  observedAt: Date;
  actor: AuditActor;
  auditEventType: string;
  locale?: string;
  changelogError?: string;
}

function persistObservation(
  db: SqliteDriver,
  input: PersistObservationInput,
): DmaSyncReport & { fields: Record<string, string> } {
  const changelogState = readProfileChangelogState(db, PROFILE_CHANGELOG_RESOURCES);
  const record = recordObservation(db, {
    requestedAt: input.requestedAt,
    requestCompletedAt: input.requestCompletedAt,
    observedAt: input.observedAt,
    requestedDomains: input.requestedDomains,
    observations: input.observations,
    changelogCursorMs: changelogState.cursor_ms,
    newestProfileEventCapturedMs: changelogState.newest_captured_at_ms,
    newestProfileEventProcessedMs: changelogState.newest_processed_at_ms,
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
  });

  let postsImported = 0;
  const results: DomainSyncResult[] = [];
  const byDomain = new Map(record.domains.map((d) => [d.domain, d]));
  for (const observation of input.observations) {
    const result = byDomain.get(observation.domain)!;
    if (observation.domain === 'MEMBER_SHARE_INFO' && observation.status === 'populated') {
      postsImported = importShareRows(db, observation.rows, input.observedAt);
    }
    const imported =
      observation.domain === 'MEMBER_SHARE_INFO'
        ? postsImported
        : isProfileSnapshotDomain(observation.domain) && observation.status === 'populated'
          ? fieldKeysForDomain(observation.domain).filter((key) => key in record.fields).length
          : 0;
    const note = noteFor(observation, result.carried_forward_from);
    results.push({
      domain: observation.domain,
      rows_fetched: observation.row_count,
      imported,
      skipped: observation.domain === 'MEMBER_SHARE_INFO' ? observation.row_count - imported : 0,
      status: observation.status,
      ...(result.failure_reason !== null ? { failure_reason: result.failure_reason } : {}),
      ...(result.carried_forward_from !== null
        ? { carried_forward_from: result.carried_forward_from }
        : {}),
      ...(note !== null ? { note } : {}),
    });
  }

  const freshness = analyzeProfileFreshness(db, record, {
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.changelogError !== undefined ? { changelogError: input.changelogError } : {}),
  });
  setObservationFreshness(db, record.id, freshness.status);

  for (const result of results) {
    db.run(
      `INSERT INTO dma_sync_state (domain, last_synced_at, rows_imported, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET last_synced_at = excluded.last_synced_at,
         rows_imported = excluded.rows_imported, note = excluded.note`,
      result.domain,
      input.observedAt.toISOString(),
      result.imported,
      result.note ?? null,
    );
  }

  appendAuditEvent(db, {
    event_type: input.auditEventType,
    actor: input.actor,
    subject_type: 'snapshot',
    ...(record.snapshot_id ? { subject_id: record.snapshot_id } : {}),
    // Domain names, counts and statuses only — never rows, never event
    // payloads. The audit log is exportable.
    payload: {
      observation_id: record.id,
      domains: results.map((r) => r.domain),
      // Named explicitly so a partial sync is legible in the audit log rather
      // than looking like a complete one with fewer rows.
      failed_domains: results.filter((r) => r.status === 'failed').map((r) => r.domain),
      empty_or_not_ready_domains: results
        .filter((r) => r.status === 'empty_or_not_ready')
        .map((r) => r.domain),
      pagination_incomplete_domains: results
        .filter((r) => r.status === 'pagination_incomplete')
        .map((r) => r.domain),
      carried_forward_domains: results
        .filter((r) => r.carried_forward_from !== undefined)
        .map((r) => r.domain),
      content_identical_to_previous: record.content_identical,
      snapshot_created: record.snapshot_created,
      freshness_status: freshness.status,
      newer_relevant_event_count: freshness.newer_relevant_event_count,
      posts_imported: postsImported,
      session_triggered: true,
    },
  });

  return {
    snapshot_id: record.snapshot_id,
    domains: results,
    posts_imported: postsImported,
    synced_at: input.observedAt.toISOString(),
    observation: {
      id: record.id,
      snapshot_created: record.snapshot_created,
      requested_at: record.requested_at,
      request_completed_at: record.request_completed_at,
      observed_at: record.observed_at,
      content_fingerprint: record.content_fingerprint,
      content_identical_to_previous: record.content_identical,
    },
    freshness,
    fields: record.fields,
  };
}

function noteFor(observation: DomainObservation, carriedFrom: string | null): string | null {
  if (observation.status === 'failed') return `failed: ${observation.failure_reason ?? 'unknown'}`;
  if (observation.status === 'pagination_incomplete') {
    return `pagination incomplete: ${observation.failure_reason ?? 'page cap reached'}`;
  }
  if (carriedFrom !== null) {
    return `empty or not ready; rendering carried forward from observation ${carriedFrom}`;
  }
  if (observation.status === 'empty_or_not_ready') {
    return 'LinkedIn returned no rows; this is not proof the section is empty';
  }
  if (observation.domain === 'MEMBER_SHARE_INFO') {
    return 'own post history; durable under the DMA portability terms';
  }
  return null;
}

function pick(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function importShareRows(
  db: SqliteDriver,
  rows: Array<Record<string, unknown>>,
  now: Date,
): number {
  // Inside the retried body — see withWriteTx's contract.
  return withWriteTx(db, () => {
    let imported = 0;
    for (const row of rows) {
      const commentary = pick(row, 'ShareCommentary', 'shareCommentary', 'Commentary');
      const postedAt = pick(row, 'Date', 'date', 'ShareDate');
      if (!commentary || !postedAt) continue;
      const existing = db.get(
        'SELECT 1 AS x FROM published_posts WHERE posted_at = ? AND char_count = ?',
        postedAt,
        commentary.length,
      );
      if (existing) continue;
      db.run(
        `INSERT INTO published_posts (id, share_url, posted_at, commentary, shared_url, media_url, visibility, char_count, hashtags_json, language_guess, artifact_id, retention_class, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'durable_dma', ?)`,
        newId('pub'),
        pick(row, 'ShareLink', 'shareLink') || null,
        postedAt,
        commentary,
        pick(row, 'SharedUrl', 'sharedUrl') || null,
        pick(row, 'MediaUrl', 'mediaUrl') || null,
        pick(row, 'Visibility', 'visibility') || null,
        commentary.length,
        JSON.stringify([
          ...new Set((commentary.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase())),
        ]),
        guessLanguageLocal(commentary),
        now.toISOString(),
      );
      imported += 1;
    }
    return imported;
  });
}

function guessLanguageLocal(text: string): string {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyrillic === 0) return 'en';
  if (latin === 0) return 'bg';
  return cyrillic > latin ? 'bg' : 'mixed';
}

// published_posts.artifact_id is NOT NULL in the schema for export-sourced rows;
// DMA rows have no artifact, so the column must be nullable. Verified by the
// migration that introduced it — see 012.
export const DMA_REQUIRES_NULLABLE_ARTIFACT = true;
