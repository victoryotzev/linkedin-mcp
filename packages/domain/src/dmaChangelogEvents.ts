import type { SqliteDriver } from '@linkedin-mcp/db';

// Normalized projection of a Member Changelog element.
//
// The raw element stays in dma_changelog_events.event_json, immutable and
// append-only — that is the record of what LinkedIn actually sent. These
// columns exist so the same row can be ordered by processedAt, followed by
// resource, and resolved across replays without re-parsing every blob.
//
// Nothing here coerces. A field that is not the type LinkedIn documents becomes
// null rather than a guess, because the one field that must never be guessed is
// processedAt: it is the fetch cursor, and the Changelog serves 28 days, so a
// cursor that runs ahead loses events permanently.

/**
 * Statuses whose payload may be used to materialize state. LinkedIn documents
 * three: SUCCESS (processed first time), FAILURE (partial or complete failure),
 * and SUCCESSFUL_REPLAY (reprocessed successfully after one or more attempts). A later
 * SUCCESSFUL_REPLAY of the same activityId supersedes an earlier FAILURE for
 * this purpose; both raw rows are kept either way.
 */
export const MATERIALIZABLE_STATUSES: readonly string[] = ['SUCCESS', 'SUCCESSFUL_REPLAY'];

/**
 * A timestamp far enough in the future is treated as unusable rather than
 * trusted. Without this bound one corrupt processedAt would advance the cursor
 * past the entire retained window and every event inside it would be lost.
 * Mirrors the clamp applied by migration 017's backfill.
 */
export const EVENT_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isValidEventTimestamp(value: unknown, nowMs: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= nowMs + EVENT_TIMESTAMP_FUTURE_SKEW_MS
  );
}

export interface NormalizedChangelogEvent {
  upstream_event_id: string | null;
  activity_id: string | null;
  resource_name: string | null;
  resource_id: string | null;
  method: string | null;
  captured_at_ms: number | null;
  processed_at_ms: number | null;
  config_version: number | null;
  activity_status: string | null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  // resourceId and id arrive as either a string or a number depending on the
  // resource; both are identifiers, so both are kept as text.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function stamp(value: unknown, nowMs: number): number | null {
  return isValidEventTimestamp(value, nowMs) ? value : null;
}

export function normalizeChangelogElement(
  row: Record<string, unknown>,
  nowMs: number,
): NormalizedChangelogEvent {
  return {
    upstream_event_id: text(row['id']),
    activity_id: typeof row['activityId'] === 'string' ? row['activityId'] : null,
    resource_name: typeof row['resourceName'] === 'string' ? row['resourceName'] : null,
    resource_id: text(row['resourceId']),
    method: typeof row['method'] === 'string' ? row['method'] : null,
    captured_at_ms: stamp(row['capturedAt'], nowMs),
    processed_at_ms: stamp(row['processedAt'], nowMs),
    config_version: integer(row['configVersion']),
    activity_status: typeof row['activityStatus'] === 'string' ? row['activityStatus'] : null,
  };
}

/** Highest usable processedAt in a batch, or null when the batch has none. */
export function newestValidProcessedAt(
  rows: Array<Record<string, unknown>>,
  nowMs: number,
): number | null {
  let newest: number | null = null;
  for (const row of rows) {
    const value = stamp(row['processedAt'], nowMs);
    if (value !== null && (newest === null || value > newest)) newest = value;
  }
  return newest;
}

export interface ProfileChangelogState {
  /** The inclusive startTime the next sync will use; null until one is known. */
  cursor_ms: number | null;
  newest_captured_at_ms: number | null;
  newest_processed_at_ms: number | null;
  event_count: number;
}

/**
 * What the changelog knows about the profile at this instant, as of the last
 * completed sync. Recorded on every observation so a later reader can see what
 * was already known when that Snapshot read was taken.
 */
export function readProfileChangelogState(
  db: SqliteDriver,
  resourceNames: readonly string[],
): ProfileChangelogState {
  const watermark = db.get(
    "SELECT processed_at_cursor_ms FROM dma_changelog_watermarks WHERE lane = 'member'",
  );
  const cursor =
    watermark && watermark['processed_at_cursor_ms'] !== null
      ? Number(watermark['processed_at_cursor_ms'])
      : null;
  if (resourceNames.length === 0) {
    return {
      cursor_ms: cursor,
      newest_captured_at_ms: null,
      newest_processed_at_ms: null,
      event_count: 0,
    };
  }
  const placeholders = resourceNames.map(() => '?').join(', ');
  const row = db.get(
    `SELECT MAX(captured_at_ms) AS captured, MAX(processed_at_ms) AS processed, COUNT(*) AS n
       FROM dma_changelog_events WHERE resource_name IN (${placeholders})`,
    ...resourceNames,
  );
  return {
    cursor_ms: cursor,
    newest_captured_at_ms:
      row && row['captured'] !== null && row['captured'] !== undefined
        ? Number(row['captured'])
        : null,
    newest_processed_at_ms:
      row && row['processed'] !== null && row['processed'] !== undefined
        ? Number(row['processed'])
        : null,
    event_count: row ? Number(row['n']) : 0,
  };
}

export interface StoredChangelogEvent extends NormalizedChangelogEvent {
  event_hash: string;
  received_at: string;
  /** Parsed `activity` object, or null when absent, empty or not an object. */
  activity: Record<string, unknown> | null;
  /** True when `activity` was present in the payload but carried no fields. */
  activity_empty: boolean;
}

function parseActivity(eventJson: string): {
  activity: Record<string, unknown> | null;
  activity_empty: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson) as unknown;
  } catch {
    return { activity: null, activity_empty: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { activity: null, activity_empty: false };
  }
  const activity = (parsed as Record<string, unknown>)['activity'];
  if (typeof activity !== 'object' || activity === null || Array.isArray(activity)) {
    return { activity: null, activity_empty: false };
  }
  const record = activity as Record<string, unknown>;
  const empty = Object.keys(record).length === 0;
  return { activity: empty ? null : record, activity_empty: empty };
}

/**
 * Reads stored events for an explicit set of resource names.
 *
 * The resource filter is a WHERE clause, not a post-filter, so payloads for
 * messages, invitations, connections and every other non-profile resource are
 * never loaded into this process at all. Callers cannot widen it accidentally:
 * an empty list returns nothing.
 */
export function readChangelogEventsByResource(
  db: SqliteDriver,
  resourceNames: readonly string[],
  /**
   * Optional LIKE prefix for sub-resources of the same family, e.g. `people/`.
   * Still an allowlist: it can only ever widen the match within one namespace,
   * and the sensitive resources live in different ones.
   */
  prefix?: string,
): StoredChangelogEvent[] {
  if (resourceNames.length === 0 && prefix === undefined) return [];
  const clauses: string[] = [];
  const params: string[] = [];
  if (resourceNames.length > 0) {
    clauses.push(`resource_name IN (${resourceNames.map(() => '?').join(', ')})`);
    params.push(...resourceNames);
  }
  if (prefix !== undefined) {
    // ESCAPE so a prefix containing _ or % cannot widen the match.
    clauses.push(`resource_name LIKE ? ESCAPE '\\'`);
    params.push(`${prefix.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const rows = db.all(
    `SELECT event_hash, event_json, received_at, upstream_event_id, activity_id,
            resource_name, resource_id, method, captured_at_ms, processed_at_ms,
            config_version, activity_status
       FROM dma_changelog_events
      WHERE ${clauses.join(' OR ')}
      ORDER BY COALESCE(processed_at_ms, 0) ASC, event_hash ASC`,
    ...params,
  );
  return rows.map((row) => {
    const { activity, activity_empty } = parseActivity(String(row['event_json']));
    return {
      event_hash: String(row['event_hash']),
      received_at: String(row['received_at']),
      upstream_event_id: (row['upstream_event_id'] as string | null) ?? null,
      activity_id: (row['activity_id'] as string | null) ?? null,
      resource_name: (row['resource_name'] as string | null) ?? null,
      resource_id: (row['resource_id'] as string | null) ?? null,
      method: (row['method'] as string | null) ?? null,
      captured_at_ms: row['captured_at_ms'] === null ? null : Number(row['captured_at_ms']),
      processed_at_ms: row['processed_at_ms'] === null ? null : Number(row['processed_at_ms']),
      config_version: row['config_version'] === null ? null : Number(row['config_version']),
      activity_status: (row['activity_status'] as string | null) ?? null,
      activity,
      activity_empty,
    };
  });
}
