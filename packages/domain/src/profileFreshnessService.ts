import type { SqliteDriver } from '@linkedin-mcp/db';
import {
  MATERIALIZABLE_STATUSES,
  readChangelogEventsByResource,
  type StoredChangelogEvent,
} from './dmaChangelogEvents.ts';
import { pickLocalized, type LocaleTag } from './dmaProfileDomains.ts';
import type { ObservationRecord } from './dmaObservationService.ts';

// How fresh is "latest", honestly.
//
// The two LinkedIn APIs disagree by design. Member Changelog knows an edit
// happened within seconds of the member making it. Member Snapshot serves data
// LinkedIn collated on its own schedule and tells you nothing about when. So a
// live Snapshot read can come back byte-identical to one from two days ago
// while the Changelog already holds the edits — observed on 2026-08-12, and the
// reason this module exists.
//
// What it will do: report that disagreement, and rebuild from changelog events
// exactly as much profile state as can be rebuilt deterministically.
// What it will not do: guess. A PARTIAL_UPDATE for a position id that was never
// seen created cannot be matched to a snapshot row, because snapshot position
// rows carry no LinkedIn ids at all — matching them on title, company or dates
// would be a heuristic dressed as a fact. Those events are surfaced unresolved.
//
// And whatever it finds, the answer is never "this is current". LinkedIn offers
// no such guarantee and the portability terms forbid implying one.

/**
 * Changelog resources that describe the profile. Used as a SQL WHERE clause,
 * so payloads for messages, invitations, connections and everything else are
 * never loaded here in the first place.
 */
export const PROFILE_CHANGELOG_RESOURCES = ['people', 'people/positions'] as const;

/**
 * SQL LIKE pattern for profile sub-resources beyond the two seen live.
 *
 * `people/positions` is the only sub-resource this product has observed, but
 * LinkedIn plainly emits the same shape for other profile sections, and
 * watching only two resources meant an edit to education, skills or
 * certifications could never register as a newer profile event — the exact
 * false-clean verdict this module exists to prevent. Everything under
 * `people/` is profile data by construction; the sensitive resources
 * (`messages`, `invitations`, `connections`) cannot match it, so widening the
 * watch does not widen what is read. Sub-resources with no deterministic
 * mapping are surfaced as unresolved rather than guessed at.
 */
export const PROFILE_CHANGELOG_RESOURCE_PREFIX = 'people/';

export type FreshnessStatus =
  | 'observed_no_newer_profile_event'
  | 'upstream_snapshot_lag_detected'
  | 'event_overlay_partial'
  | 'partial_domain_fetch'
  | 'unknown';

export type UnresolvedReason =
  | 'unknown_resource_partial_update'
  | 'unknown_resource_delete'
  | 'empty_activity'
  | 'failed_processing'
  | 'missing_resource_id'
  | 'unmapped_person_field'
  | 'unsupported_resource_or_version';

export interface OverlayChange {
  kind:
    | 'person_field'
    | 'position_created'
    | 'position_updated'
    | 'position_deleted'
    // Every other people/<collection>. Positions keep their own three kinds
    // because the tool schema and this product's history already name them.
    | 'resource_created'
    | 'resource_updated'
    | 'resource_deleted';
  resource_name: string;
  resource_id: string | null;
  method: string;
  field: string | null;
  summary: string;
  captured_at_ms: number | null;
  processed_at_ms: number | null;
}

export interface UnresolvedChange {
  reason: UnresolvedReason;
  resource_name: string | null;
  resource_id: string | null;
  method: string | null;
  config_version: number | null;
  activity_status: string | null;
  captured_at_ms: number | null;
  processed_at_ms: number | null;
  /** Names what could not be resolved. Never carries an activity value. */
  detail: string;
}

export interface EventDerivedResource {
  resource_id: string;
  fields: Record<string, unknown>;
}

/** Kept as the name the tool schema and the existing tests already use. */
export type EventDerivedPosition = EventDerivedResource;

export interface EventDerivedProfile {
  person: Record<string, string>;
  positions: EventDerivedPosition[];
  /**
   * Every other `people/<collection>` rebuilt by the same rules, keyed by the
   * collection name — `certifications`, `educations`, `skills` and so on.
   *
   * Only positions had a handler before, so an edit to any other section fell
   * through to "no deterministic profile mapping" and was reported unresolved.
   * That was not a statement about the data: the events carry the same
   * CREATE/UPDATE/PARTIAL_UPDATE/DELETE shape, and refusing to read them meant a
   * certification the member added was invisible to the overlay even though the
   * changelog had described it exactly.
   */
  collections: Record<string, EventDerivedResource[]>;
}

export interface NewestProfileEvent {
  resource_name: string | null;
  method: string | null;
  captured_at_ms: number | null;
  processed_at_ms: number | null;
}

export interface ProfileFreshnessReport {
  /** Structural, not a field anyone may set. LinkedIn guarantees nothing here. */
  guarantee: 'not_guaranteed';
  status: FreshnessStatus;
  /** Every other rule that also fired; precedence only picks the headline. */
  secondary_signals: FreshnessStatus[];
  reasons: string[];
  recommended_next_action: string;
  observation_id: string;
  snapshot_id: string | null;
  content_fingerprint: string;
  /** null when there is no earlier DMA observation to compare against. */
  content_changed_from_previous: boolean | null;
  requested_at: string;
  request_completed_at: string;
  observed_at: string;
  domains: {
    requested: string[];
    populated: string[];
    empty_or_not_ready: string[];
    failed: string[];
    pagination_incomplete: string[];
    carried_forward: string[];
    /** Profile domains this read never asked LinkedIn about. */
    not_requested: string[];
  };
  changelog_cursor_ms: number | null;
  changelog_window_days: number;
  newest_profile_event: NewestProfileEvent | null;
  newer_relevant_event_count: number;
  applied_overlay: OverlayChange[];
  unresolved_changes: UnresolvedChange[];
  event_derived: EventDerivedProfile;
  /**
   * Totals before the response cap, and which lists were shortened. The overlay
   * is rebuilt from every retained profile event on every read, so a member who
   * edits often accumulates entries indefinitely; the payload is capped so a
   * tool result stays a readable answer rather than a transcript.
   */
  truncated: {
    applied_overlay: boolean;
    unresolved_changes: boolean;
    event_derived_positions: boolean;
    applied_overlay_total: number;
    unresolved_changes_total: number;
    event_derived_positions_total: number;
  };
}

/**
 * Response cap for the three unbounded lists. The newest entries are kept:
 * an overlay is most useful for what changed recently, and the totals stay
 * visible either way.
 */
const MAX_REPORTED_ENTRIES = 200;

function capTail<T>(items: T[]): { items: T[]; truncated: boolean } {
  return items.length <= MAX_REPORTED_ENTRIES
    ? { items, truncated: false }
    : { items: items.slice(-MAX_REPORTED_ENTRIES), truncated: true };
}

/** The rolling window LinkedIn serves. Anything older is simply not available. */
const CHANGELOG_WINDOW_DAYS = 28;

/**
 * `people` activity keys this product knows how to place. Everything else is
 * reported by key name rather than applied — an unrecognised field could be
 * anything, and putting it somewhere plausible is how a profile read starts
 * lying.
 */
const PERSON_FIELD_MAP: Record<string, string> = {
  headline: 'headline',
  summary: 'about',
  firstName: 'first_name',
  lastName: 'last_name',
};

function effectiveTime(event: { captured_at_ms: number | null; processed_at_ms: number | null }) {
  return event.captured_at_ms ?? event.processed_at_ms;
}

function unresolvedFrom(
  event: StoredChangelogEvent,
  reason: UnresolvedReason,
  detail: string,
): UnresolvedChange {
  return {
    reason,
    resource_name: event.resource_name,
    resource_id: event.resource_id,
    method: event.method,
    config_version: event.config_version,
    activity_status: event.activity_status,
    captured_at_ms: event.captured_at_ms,
    processed_at_ms: event.processed_at_ms,
    detail,
  };
}

/**
 * One activity, possibly recorded more than once.
 *
 * LinkedIn documents SUCCESSFUL_REPLAY as "successfully reprocessed after one
 * or many attempts", so a later replay is the record to materialize from and an
 * earlier FAILURE for the same activityId is superseded. Both rows stay on disk
 * either way — the raw changelog is append-only history, not a cache.
 */
interface ActivityGroup {
  key: string;
  records: StoredChangelogEvent[];
  representative: StoredChangelogEvent | null;
  /** Newest member-action time in the group (capturedAt, else processedAt). */
  newestMs: number | null;
  /** Newest LinkedIn processing time, for comparison against a stored baseline. */
  newestProcessedMs: number | null;
  /** Newest local receipt time, for events LinkedIn never stamped. */
  newestReceivedMs: number | null;
}

function groupByActivity(events: readonly StoredChangelogEvent[]): ActivityGroup[] {
  const groups = new Map<string, StoredChangelogEvent[]>();
  for (const event of events) {
    const key = event.activity_id ?? `hash:${event.event_hash}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }

  const out: ActivityGroup[] = [];
  for (const [key, records] of groups) {
    const ordered = [...records].sort(
      (a, b) =>
        (a.processed_at_ms ?? 0) - (b.processed_at_ms ?? 0) ||
        (a.event_hash < b.event_hash ? -1 : a.event_hash > b.event_hash ? 1 : 0),
    );
    // A null activityStatus is not a failure: the field is newer than the API
    // itself, so events captured before it shipped simply do not carry one.
    const materializable = ordered.filter(
      (event) =>
        event.activity_status === null || MATERIALIZABLE_STATUSES.includes(event.activity_status),
    );
    const maxOf = (pick: (event: StoredChangelogEvent) => number | null): number | null =>
      ordered.reduce<number | null>((max, event) => {
        const value = pick(event);
        return value !== null && (max === null || value > max) ? value : max;
      }, null);
    out.push({
      key,
      records: ordered,
      representative: materializable.at(-1) ?? null,
      newestMs: maxOf(effectiveTime),
      newestProcessedMs: maxOf((event) => event.processed_at_ms),
      newestReceivedMs: maxOf((event) => {
        const parsed = Date.parse(event.received_at);
        return Number.isNaN(parsed) ? null : parsed;
      }),
    });
  }

  // Ordered by when the MEMBER acted, not by when LinkedIn finished processing.
  // Those differ: a FAILURE that is replayed successfully keeps its original
  // capturedAt but gets a much later processedAt, so ordering on processedAt
  // replays an old activity after newer ones and lets it win — resurrecting a
  // position the member had since deleted, or restoring a superseded headline.
  return out.sort(
    (a, b) =>
      (a.newestMs ?? 0) - (b.newestMs ?? 0) ||
      (a.representative?.processed_at_ms ?? 0) - (b.representative?.processed_at_ms ?? 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** Resolves localized leaves so an overlay value is a string, not a shape. */
function simplifyActivity(
  activity: Record<string, unknown>,
  locale?: LocaleTag,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(activity).sort()) {
    const resolved = pickLocalized(activity[key], locale);
    out[key] = resolved !== null ? resolved : activity[key];
  }
  return out;
}

interface OverlayResult {
  applied: OverlayChange[];
  unresolved: UnresolvedChange[];
  derived: EventDerivedProfile;
}

function buildOverlay(groups: readonly ActivityGroup[], locale?: LocaleTag): OverlayResult {
  const applied: OverlayChange[] = [];
  const unresolved: UnresolvedChange[] = [];
  const person: Record<string, string> = {};
  // One store per people/<collection>. Positions are simply the collection this
  // product saw first; nothing about the event shape is special to them.
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const storeFor = (collection: string): Map<string, Record<string, unknown>> => {
    const existing = collections.get(collection);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    collections.set(collection, created);
    return created;
  };

  for (const group of groups) {
    const event = group.representative;
    if (event === null) {
      const failed = group.records.at(-1)!;
      unresolved.push(
        unresolvedFrom(
          failed,
          'failed_processing',
          `LinkedIn reported ${failed.activity_status ?? 'a failure'} for this activity and never replayed it successfully`,
        ),
      );
      continue;
    }

    const method = event.method ?? '';
    const resource = event.resource_name ?? '';
    if (resource === 'people') {
      applyPersonEvent(event, method, person, applied, unresolved, locale);
      continue;
    }
    if (resource.startsWith(PROFILE_CHANGELOG_RESOURCE_PREFIX)) {
      const collection = resource.slice(PROFILE_CHANGELOG_RESOURCE_PREFIX.length);
      // `people/` alone, or a nested path, is not a collection this can key on.
      if (collection !== '' && !collection.includes('/')) {
        applyCollectionEvent(
          collection,
          event,
          method,
          storeFor(collection),
          applied,
          unresolved,
          locale,
        );
        continue;
      }
    }
    unresolved.push(
      unresolvedFrom(
        event,
        'unsupported_resource_or_version',
        `resource ${event.resource_name ?? '(none)'} has no deterministic profile mapping`,
      ),
    );
  }

  const sortedEntries = (store: Map<string, Record<string, unknown>>): EventDerivedResource[] =>
    [...store.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([resource_id, fields]) => ({ resource_id, fields }));

  const derivedCollections: Record<string, EventDerivedResource[]> = {};
  for (const name of [...collections.keys()].sort()) {
    if (name === 'positions') continue;
    derivedCollections[name] = sortedEntries(collections.get(name)!);
  }

  return {
    applied,
    unresolved,
    derived: {
      person,
      positions: sortedEntries(collections.get('positions') ?? new Map()),
      collections: derivedCollections,
    },
  };
}

/**
 * Rebuilds one `people/<collection>` from its changelog events.
 *
 * The rules are the collection-agnostic ones that were written for positions:
 * CREATE establishes the key even with an empty payload, UPDATE replaces,
 * PARTIAL_UPDATE merges, DELETE removes, and anything referring to a resource no
 * observed CREATE established is surfaced rather than matched by heuristic.
 * Snapshot rows carry no LinkedIn ids in any collection, so guessing would be as
 * wrong for a certification as it always was for a position.
 */
function applyCollectionEvent(
  collection: string,
  event: StoredChangelogEvent,
  method: string,
  store: Map<string, Record<string, unknown>>,
  applied: OverlayChange[],
  unresolved: UnresolvedChange[],
  locale?: LocaleTag,
): void {
  const resourceName = `${PROFILE_CHANGELOG_RESOURCE_PREFIX}${collection}`;
  const isPosition = collection === 'positions';
  // The singular the summaries read with: "position 123 created".
  const noun = collection.endsWith('s') ? collection.slice(0, -1) : collection;
  const kindFor = (verb: 'created' | 'updated' | 'deleted'): OverlayChange['kind'] =>
    isPosition
      ? (`position_${verb}` as OverlayChange['kind'])
      : (`resource_${verb}` as OverlayChange['kind']);

  const resourceId = event.resource_id;
  const change = (
    kind: OverlayChange['kind'],
    summary: string,
    field: string | null = null,
  ): OverlayChange => ({
    kind,
    resource_name: resourceName,
    resource_id: resourceId,
    method,
    field,
    summary,
    captured_at_ms: event.captured_at_ms,
    processed_at_ms: event.processed_at_ms,
  });

  if (resourceId === null) {
    unresolved.push(
      unresolvedFrom(event, 'missing_resource_id', `${method || 'event'} carries no resource id`),
    );
    return;
  }

  if (method === 'CREATE') {
    // The key is established even when the payload is empty: "a position with
    // this id exists" is something the event states outright, and it is what
    // lets a later PARTIAL_UPDATE or DELETE resolve instead of dangling.
    const fields = event.activity === null ? {} : simplifyActivity(event.activity, locale);
    store.set(resourceId, fields);
    applied.push(change(kindFor('created'), `${noun} ${resourceId} created`));
    if (event.activity === null) {
      unresolved.push(
        unresolvedFrom(
          event,
          'empty_activity',
          `CREATE for ${noun} ${resourceId} carried no activity fields`,
        ),
      );
    }
    return;
  }

  if (method === 'UPDATE' || method === 'PARTIAL_UPDATE') {
    const existing = store.get(resourceId);
    if (existing === undefined) {
      // Snapshot rows have no LinkedIn ids in any collection, so there is
      // nothing to match this against without inventing a heuristic.
      unresolved.push(
        unresolvedFrom(
          event,
          'unknown_resource_partial_update',
          `${method} for ${noun} ${resourceId}, which no observed CREATE established`,
        ),
      );
      return;
    }
    if (event.activity === null) {
      unresolved.push(
        unresolvedFrom(
          event,
          'empty_activity',
          `${method} for ${noun} ${resourceId} carried no activity fields`,
        ),
      );
      return;
    }
    const patch = simplifyActivity(event.activity, locale);
    // UPDATE is a full replacement of the resource; PARTIAL_UPDATE is a merge.
    // Merging an UPDATE keeps fields the member has just removed, so a deleted
    // description would still be reported as current derived state.
    store.set(resourceId, method === 'UPDATE' ? patch : { ...existing, ...patch });
    applied.push(
      change(
        kindFor('updated'),
        method === 'UPDATE'
          ? `${noun} ${resourceId} replaced: ${Object.keys(patch).sort().join(', ')}`
          : `${noun} ${resourceId} updated: ${Object.keys(patch).sort().join(', ')}`,
      ),
    );
    return;
  }

  if (method === 'DELETE') {
    if (!store.has(resourceId)) {
      unresolved.push(
        unresolvedFrom(
          event,
          'unknown_resource_delete',
          `DELETE for ${noun} ${resourceId}, which no observed CREATE established`,
        ),
      );
      return;
    }
    store.delete(resourceId);
    applied.push(change(kindFor('deleted'), `${noun} ${resourceId} deleted`));
    return;
  }

  unresolved.push(
    unresolvedFrom(
      event,
      'unsupported_resource_or_version',
      `method ${method || '(none)'} on ${resourceName} has no deterministic mapping`,
    ),
  );
}

function applyPersonEvent(
  event: StoredChangelogEvent,
  method: string,
  person: Record<string, string>,
  applied: OverlayChange[],
  unresolved: UnresolvedChange[],
  locale?: LocaleTag,
): void {
  if (method === 'DELETE') {
    unresolved.push(
      unresolvedFrom(event, 'unsupported_resource_or_version', 'DELETE on people is never applied'),
    );
    return;
  }
  if (method !== 'CREATE' && method !== 'UPDATE' && method !== 'PARTIAL_UPDATE') {
    unresolved.push(
      unresolvedFrom(
        event,
        'unsupported_resource_or_version',
        `method ${method || '(none)'} on people has no deterministic mapping`,
      ),
    );
    return;
  }
  if (event.activity === null) {
    unresolved.push(
      unresolvedFrom(event, 'empty_activity', `${method} on people carried no activity fields`),
    );
    return;
  }

  // A full UPDATE replaces the person, so a field the member cleared must not
  // survive from an earlier event.
  if (method === 'UPDATE') {
    for (const key of Object.keys(person)) delete person[key];
  }
  const keys = Object.keys(event.activity).sort();
  for (const key of keys) {
    const mapped = PERSON_FIELD_MAP[key];
    if (mapped !== undefined) {
      const value = pickLocalized(event.activity[key], locale);
      if (value !== null && value.trim().length > 0) {
        person[mapped] = value.trim();
        applied.push({
          kind: 'person_field',
          resource_name: 'people',
          resource_id: event.resource_id,
          method,
          field: mapped,
          summary: `${mapped} set from a ${method} event`,
          captured_at_ms: event.captured_at_ms,
          processed_at_ms: event.processed_at_ms,
        });
      } else {
        unresolved.push(
          unresolvedFrom(
            event,
            'unmapped_person_field',
            `activity.${key} carried no usable value for the requested locale`,
          ),
        );
      }
      continue;
    }
    // LinkedIn ships `<field>Timestamps` alongside the field it describes; it
    // is metadata about a change already accounted for, not a change.
    const timestampsOf = /^(.+)Timestamps$/.exec(key)?.[1];
    if (timestampsOf !== undefined && PERSON_FIELD_MAP[timestampsOf] !== undefined) continue;

    // Key path only. The value is unrecognised profile data and does not need
    // to be echoed to say that it was not applied.
    unresolved.push(
      unresolvedFrom(
        event,
        'unmapped_person_field',
        `activity.${key} has no deterministic canonical mapping`,
      ),
    );
  }
}

/**
 * What "newer than last time" is measured against.
 *
 * NOT the previous observation. The anchor is the most recent observation whose
 * Snapshot content actually moved — because that is the last moment LinkedIn
 * demonstrably materialized anything. Anchoring on the previous read instead
 * makes the lag verdict fire exactly once and then vanish: read 2 reports the
 * pending edit, read 3 finds it older than read 2 and calls the still-stale
 * profile clean. A lag that persists for days must keep being reported for as
 * long as it persists.
 *
 * The first observation always qualifies (nothing was comparable, so its
 * content_identical is 0), which is correct — it is where content was
 * established.
 */
interface FreshnessBaseline {
  observation_id: string | null;
  /** Newest profile-event processedAt known at the anchor. LinkedIn's clock. */
  processed_at_ms: number | null;
  /** When the anchor read completed. Ours, for events LinkedIn never stamped. */
  observed_at_ms: number | null;
}

const NO_BASELINE: FreshnessBaseline = {
  observation_id: null,
  processed_at_ms: null,
  observed_at_ms: null,
};

function contentBaseline(
  db: SqliteDriver,
  previousObservationId: string | null,
): FreshnessBaseline {
  if (previousObservationId === null) return NO_BASELINE;
  const row = db.get(
    // content_identical = 0 also means "compared nothing at all" — a first read,
    // or a read of a domain never fetched before. Anchoring on one of those
    // promotes an observation that measured nothing to "content moved here",
    // which pushes the baseline past a pending edit and silences a lag that is
    // still happening. comparable_domain_count is NULL on rows written before
    // migration 018 and those are read as informative, which is how they were
    // treated already.
    `SELECT id, observed_at, newest_profile_event_processed_ms
       FROM dma_snapshot_observations
      WHERE content_identical = 0
        AND COALESCE(comparable_domain_count, 1) > 0
        AND seq <= (SELECT seq FROM dma_snapshot_observations WHERE id = ?)
      ORDER BY seq DESC LIMIT 1`,
    previousObservationId,
  );
  // No observation has demonstrably moved yet — every read so far either
  // matched or had nothing to compare. The content baseline is then the first
  // observation there was: it is where the content we are holding came from.
  // Without this fallback the guard above would leave a brand-new database with
  // no baseline at all, and nothing could ever be called newer.
  const anchor =
    row ??
    db.get(
      `SELECT id, observed_at, newest_profile_event_processed_ms
         FROM dma_snapshot_observations
        WHERE seq <= (SELECT seq FROM dma_snapshot_observations WHERE id = ?)
        ORDER BY seq ASC LIMIT 1`,
      previousObservationId,
    );
  if (!anchor) return NO_BASELINE;
  const parsed = Date.parse(String(anchor['observed_at']));
  return {
    observation_id: String(anchor['id']),
    processed_at_ms:
      anchor['newest_profile_event_processed_ms'] === null
        ? null
        : Number(anchor['newest_profile_event_processed_ms']),
    observed_at_ms: Number.isNaN(parsed) ? null : parsed,
  };
}

/**
 * Comparisons stay inside one clock.
 *
 * capturedAt is LinkedIn's record of when the member acted and is routinely
 * earlier than our previous request even for an event LinkedIn only processed
 * afterwards — so comparing it against our local clock hides exactly the events
 * that could not have been in the earlier Snapshot. processedAt goes against
 * the processedAt the anchor recorded; an event LinkedIn never stamped falls
 * back to when we received it versus when the anchor read completed.
 */
function isNewerThanBaseline(group: ActivityGroup, baseline: FreshnessBaseline): boolean {
  if (baseline.observation_id === null) return false;
  if (group.newestProcessedMs !== null) {
    return baseline.processed_at_ms === null || group.newestProcessedMs > baseline.processed_at_ms;
  }
  return (
    baseline.observed_at_ms !== null &&
    group.newestReceivedMs !== null &&
    group.newestReceivedMs > baseline.observed_at_ms
  );
}

export interface AnalyzeFreshnessOptions {
  locale?: LocaleTag;
  /** Set when the changelog step failed, so nothing is known about pending edits. */
  changelogError?: string;
}

export function analyzeProfileFreshness(
  db: SqliteDriver,
  observation: ObservationRecord,
  opts: AnalyzeFreshnessOptions = {},
): ProfileFreshnessReport {
  const events = readChangelogEventsByResource(
    db,
    PROFILE_CHANGELOG_RESOURCES,
    PROFILE_CHANGELOG_RESOURCE_PREFIX,
  );
  const groups = groupByActivity(events);
  const overlay = buildOverlay(groups, opts.locale);

  const baseline = contentBaseline(db, observation.previous_observation_id);
  const newerGroups = groups.filter((group) => isNewerThanBaseline(group, baseline));

  const newest = groups.reduce<ActivityGroup | null>((best, group) => {
    if (group.newestMs === null) return best;
    if (best === null || best.newestMs === null || group.newestMs > best.newestMs) return group;
    return best;
  }, null);
  const newestRecord = newest?.representative ?? newest?.records.at(-1) ?? null;

  const bucket = (status: string) =>
    observation.domains.filter((d) => d.status === status).map((d) => d.domain);
  const carriedForward = observation.domains
    .filter((d) => d.carried_forward_from !== null)
    .map((d) => d.domain);
  const failed = bucket('failed');
  const incomplete = bucket('pagination_incomplete');
  const notRequested = observation.carried_forward_not_requested;
  const emptyOrNotReady = bucket('empty_or_not_ready');

  // null means "cannot say", and it is the honest answer whenever no domain
  // could be compared — every domain failed, or every one is being observed for
  // the first time. Reporting `true` there would assert a change that was never
  // measured.
  const contentChanged =
    observation.comparable_domain_count === 0 ? null : !observation.content_identical;

  const reasons: string[] = [];
  const signals: FreshnessStatus[] = [];

  // empty_or_not_ready belongs here too. LinkedIn's page-zero "No data found"
  // is identical whether the member has no entries or the domain has not been
  // collated, so a read containing one cannot be called complete — that is the
  // whole premise of the status. Leaving it out let a first read after
  // onboarding, where most domains are not yet collated, come back clean.
  if (
    failed.length > 0 ||
    incomplete.length > 0 ||
    carriedForward.length > 0 ||
    notRequested.length > 0 ||
    emptyOrNotReady.length > 0
  ) {
    signals.push('partial_domain_fetch');
    if (emptyOrNotReady.length > 0) {
      reasons.push(
        `domain(s) returned no rows, which is not proof the section is empty: ${emptyOrNotReady.join(', ')}`,
      );
    }
    if (notRequested.length > 0) {
      reasons.push(
        `domain(s) not requested by this read, whose values were reused from an earlier observation: ${notRequested.join(', ')}`,
      );
    }
    if (failed.length > 0) reasons.push(`domain(s) failed: ${failed.join(', ')}`);
    if (incomplete.length > 0) {
      reasons.push(
        `domain(s) exceeded the pagination cap and may be incomplete: ${incomplete.join(', ')}`,
      );
    }
    if (carriedForward.length > 0) {
      reasons.push(
        `domain(s) returned no usable data and were carried forward from an earlier observation: ${carriedForward.join(', ')}`,
      );
    }
  }

  // Any profile domain that did not move is enough. Requiring the whole read
  // to be unchanged meant one materialised domain suppressed the warning for
  // every other — a stale headline handed back silently because an unrelated
  // skill had landed.
  if (newerGroups.length > 0 && observation.unchanged_domains.length > 0) {
    signals.push('upstream_snapshot_lag_detected');
    reasons.push(
      `${newerGroups.length} profile changelog activity(ies) postdate the last observation whose Snapshot content changed, yet domain(s) ${observation.unchanged_domains.join(', ')} returned content identical to the previous read`,
    );
  }

  if (overlay.unresolved.length > 0) {
    signals.push('event_overlay_partial');
    reasons.push(
      `${overlay.applied.length} changelog change(s) could be reconciled deterministically and ${overlay.unresolved.length} could not`,
    );
  }

  if (opts.changelogError !== undefined) {
    // Without a reconciled Changelog there is no basis for saying nothing is
    // pending, so the clean status is not available on this read.
    reasons.push(
      `the Member Changelog could not be reconciled on this read, so pending profile edits are unknown: ${opts.changelogError}`,
    );
  }

  if (newerGroups.length === 0 && opts.changelogError === undefined) {
    signals.push('observed_no_newer_profile_event');
    reasons.push(
      baseline.observation_id === null
        ? 'no earlier DMA observation exists, so nothing can be called newer than it'
        : 'no profile changelog activity is newer than the last observation whose Snapshot content changed',
    );
  }

  if (signals.length === 0) {
    signals.push('unknown');
    reasons.push(
      'the Snapshot content changed and every newer profile event was reconciled, but LinkedIn does not state which edits a Snapshot response includes',
    );
  }

  const status = signals[0]!;
  const appliedPage = capTail(overlay.applied);
  const unresolvedPage = capTail(overlay.unresolved);
  const positionsPage = capTail(overlay.derived.positions);
  return {
    guarantee: 'not_guaranteed',
    status,
    secondary_signals: signals.slice(1),
    reasons,
    recommended_next_action: nextAction(status, failed, incomplete, [
      ...carriedForward,
      ...notRequested,
    ]),
    observation_id: observation.id,
    snapshot_id: observation.snapshot_id,
    content_fingerprint: observation.content_fingerprint,
    content_changed_from_previous: contentChanged,
    requested_at: observation.requested_at,
    request_completed_at: observation.request_completed_at,
    observed_at: observation.observed_at,
    domains: {
      requested: [...observation.requested_domains],
      populated: bucket('populated'),
      empty_or_not_ready: bucket('empty_or_not_ready'),
      failed,
      pagination_incomplete: incomplete,
      carried_forward: carriedForward,
      not_requested: notRequested,
    },
    changelog_cursor_ms: observation.changelog_cursor_ms,
    changelog_window_days: CHANGELOG_WINDOW_DAYS,
    newest_profile_event:
      newestRecord === null
        ? null
        : {
            resource_name: newestRecord.resource_name,
            method: newestRecord.method,
            captured_at_ms: newestRecord.captured_at_ms,
            processed_at_ms: newestRecord.processed_at_ms,
          },
    newer_relevant_event_count: newerGroups.length,
    applied_overlay: appliedPage.items,
    unresolved_changes: unresolvedPage.items,
    event_derived: {
      person: overlay.derived.person,
      positions: positionsPage.items,
      collections: overlay.derived.collections,
    },
    truncated: {
      applied_overlay: appliedPage.truncated,
      unresolved_changes: unresolvedPage.truncated,
      event_derived_positions: positionsPage.truncated,
      applied_overlay_total: overlay.applied.length,
      unresolved_changes_total: overlay.unresolved.length,
      event_derived_positions_total: overlay.derived.positions.length,
    },
  };
}

function nextAction(
  status: FreshnessStatus,
  failed: readonly string[],
  incomplete: readonly string[],
  carried: readonly string[],
): string {
  switch (status) {
    case 'partial_domain_fetch': {
      const names = [...new Set([...failed, ...incomplete, ...carried])].join(', ');
      return `Re-run this read for ${names || 'the affected domains'} later. LinkedIn collates Snapshot domains at different times, so a domain that answers with nothing now may answer later; nothing here proves those sections are empty.`;
    }
    case 'upstream_snapshot_lag_detected':
      return "LinkedIn's Snapshot has not materialized the edits its own Changelog already recorded. Re-run this read later — LinkedIn gives no timetable for collation and no completeness guarantee. Treat the overlay as evidence of what changed, not as the profile.";
    case 'event_overlay_partial':
      return 'Review unresolved_changes: these events cannot be matched to profile state deterministically (Snapshot position rows carry no LinkedIn ids). Apply anything that matters through linkedin_profile_update after checking it by hand.';
    case 'observed_no_newer_profile_event':
      return 'Nothing further is pending from the Changelog. Re-run when you want another live read; note the Changelog only retains 28 days, so a long gap loses history permanently.';
    case 'unknown':
    default:
      return 'Re-run later and compare fingerprints. LinkedIn does not state which edits a given Snapshot response includes, so a changed Snapshot is not proof that every recorded edit is present.';
  }
}
