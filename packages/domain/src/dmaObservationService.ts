import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { canonicalJson, newId, type Jsonish } from '@linkedin-mcp/shared';
import {
  PROFILE_SNAPSHOT_DOMAINS,
  fieldKeysForDomain,
  fingerprintObservation,
  isProfileSnapshotDomain,
  renderProfileDomain,
  type DomainObservation,
  type DomainObservationStatus,
  type LocaleTag,
  type ProfileSnapshotDomain,
} from './dmaProfileDomains.ts';

// What one live read of the portability lane actually saw.
//
// This is deliberately a different thing from a snapshot. A snapshot is a
// version of the member's profile as this app understands it; an observation is
// one request against LinkedIn and what came back. LinkedIn returning the same
// bytes three days running is three observations of one profile state, not
// three profile states — which is precisely the fact the freshness verdict
// needs, and precisely what a row-per-request snapshot table would destroy.
//
// The observation is also where the honest timestamps live. The Member Snapshot
// API supplies no data-generation time anywhere, so nothing here may be
// presented as "when LinkedIn produced this"; these columns say when we asked
// and when the answer finished arriving, and linkedin_snapshots.taken_at stays
// null for this lane.

export interface DomainResultRecord {
  domain: string;
  status: DomainObservationStatus;
  row_count: number;
  fingerprint: string | null;
  failure_reason: string | null;
  /**
   * Set when the rendered field for this domain was reused from an earlier
   * observation because this read returned nothing usable. Any value here keeps
   * the observation out of every complete/clean freshness verdict.
   */
  carried_forward_from: string | null;
}

export interface ObservationRecord {
  id: string;
  snapshot_id: string | null;
  snapshot_created: boolean;
  requested_at: string;
  request_completed_at: string;
  observed_at: string;
  content_fingerprint: string;
  previous_observation_id: string | null;
  previous_content_fingerprint: string | null;
  /**
   * Every domain LinkedIn answered this time returned exactly what it returned
   * the last time it answered that domain. Compared per domain rather than
   * across the whole read, so one failing domain cannot hide the lag signal.
   * False when nothing was comparable, including on a first observation.
   */
  content_identical: boolean;
  /**
   * How many domains this read could actually compare against a previous
   * fingerprint. Zero means nothing is known about change either way, which is
   * a different thing from "changed".
   */
  comparable_domain_count: number;
  /** Profile domains that returned exactly what they returned last time. */
  unchanged_domains: string[];
  /** Profile domains whose content differed from the last comparable read. */
  changed_domains: string[];
  changelog_cursor_ms: number | null;
  newest_profile_event_captured_ms: number | null;
  newest_profile_event_processed_ms: number | null;
  requested_domains: string[];
  domains: DomainResultRecord[];
  /**
   * Profile domains this read did not request, whose last known rendering was
   * reused so the snapshot stays a whole profile. Like any carry-forward, it
   * keeps the observation out of every complete verdict.
   */
  carried_forward_not_requested: string[];
  /** The rendered profile as this observation leaves it, keyed by field. */
  fields: Record<string, string>;
}

export interface RecordObservationInput {
  requestedAt: Date;
  requestCompletedAt: Date;
  observedAt: Date;
  requestedDomains: readonly string[];
  observations: readonly DomainObservation[];
  changelogCursorMs: number | null;
  newestProfileEventCapturedMs: number | null;
  newestProfileEventProcessedMs: number | null;
  locale?: LocaleTag;
}

interface PreviousObservationRow {
  id: string;
  snapshot_id: string | null;
  content_fingerprint: string | null;
}

function previousObservation(db: SqliteDriver): PreviousObservationRow | null {
  const row = db.get(
    `SELECT id, snapshot_id, content_fingerprint
       FROM dma_snapshot_observations ORDER BY seq DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: String(row['id']),
    snapshot_id: (row['snapshot_id'] as string | null) ?? null,
    content_fingerprint: (row['content_fingerprint'] as string | null) ?? null,
  };
}

/**
 * Most recent observation whose snapshot still holds this domain's rendering.
 *
 * Preferred path is the domain-result row that says the domain came back
 * populated. The fallback exists for observations that have no domain results
 * at all — migration 017 backfills one per pre-existing DMA snapshot, and
 * without the fallback the first read after the migration would find no
 * carry-forward source and quietly drop every section LinkedIn had not yet
 * collated, with a clean verdict.
 */
function lastPopulated(
  db: SqliteDriver,
  domain: string,
  fieldKeys: readonly string[],
): { observation_id: string; snapshot_id: string } | null {
  const row = db.get(
    `SELECT r.observation_id AS observation_id, o.snapshot_id AS snapshot_id
       FROM dma_snapshot_domain_results r
       JOIN dma_snapshot_observations o ON o.id = r.observation_id
      WHERE r.domain = ? AND r.status = 'populated' AND o.snapshot_id IS NOT NULL
      ORDER BY o.seq DESC LIMIT 1`,
    domain,
  );
  if (row) {
    return {
      observation_id: String(row['observation_id']),
      snapshot_id: String(row['snapshot_id']),
    };
  }
  if (fieldKeys.length === 0) return null;
  // Any snapshot holding this domain's rendering will do, whatever produced it.
  // Restricting the fallback to observations missed two real sources: rows
  // migration 017 backfilled (which have no domain results) and snapshots
  // imported from a LinkedIn export (which have no observation at all). In both
  // cases the section would be dropped from the new snapshot the first time
  // LinkedIn answered that domain with nothing.
  const placeholders = fieldKeys.map(() => '?').join(', ');
  const fallback = db.get(
    `SELECT s.id AS snapshot_id,
            (SELECT o.id FROM dma_snapshot_observations o
              WHERE o.snapshot_id = s.id ORDER BY o.seq DESC LIMIT 1) AS observation_id
       FROM linkedin_snapshots s
      WHERE EXISTS (
          SELECT 1 FROM snapshot_fields f
           WHERE f.snapshot_id = s.id AND f.field_key IN (${placeholders})
        )
      ORDER BY s.version DESC LIMIT 1`,
    ...fieldKeys,
  );
  if (!fallback) return null;
  const snapshotId = String(fallback['snapshot_id']);
  return {
    // An export-imported snapshot has no observation to point at; the snapshot
    // id is the honest provenance in that case.
    observation_id: (fallback['observation_id'] as string | null) ?? `snapshot:${snapshotId}`,
    snapshot_id: snapshotId,
  };
}

/**
 * The last time this domain produced comparable content, and where those bytes
 * are stored.
 *
 * `fingerprint IS NOT NULL` is load-bearing, not a tidy-up. Failed and
 * pagination-incomplete reads store no fingerprint; taking simply the most
 * recent row would make the domain incomparable on the read after any transient
 * failure, so a genuine content change would be excluded from the identity test
 * and the read would claim `content_identical` while the profile had in fact
 * changed — inverting the lag verdict.
 */
function lastRawHolder(
  db: SqliteDriver,
  domain: string,
): { observation_id: string; fingerprint: string | null; holder: string | null } | null {
  const row = db.get(
    `SELECT r.observation_id AS observation_id, r.fingerprint AS fingerprint,
            r.raw_json IS NOT NULL AS has_raw,
            r.raw_same_as_observation_id AS same_as
       FROM dma_snapshot_domain_results r
       JOIN dma_snapshot_observations o ON o.id = r.observation_id
      WHERE r.domain = ? AND r.fingerprint IS NOT NULL
      ORDER BY o.seq DESC LIMIT 1`,
    domain,
  );
  if (!row) return null;
  const observationId = String(row['observation_id']);
  const holder =
    Number(row['has_raw']) === 1 ? observationId : ((row['same_as'] as string | null) ?? null);
  return {
    observation_id: observationId,
    fingerprint: (row['fingerprint'] as string | null) ?? null,
    holder,
  };
}

/**
 * Copies a domain's last known rendering into `fields`, returning the
 * observation it came from, or null when there is nothing to carry.
 */
function carryForward(
  db: SqliteDriver,
  domain: ProfileSnapshotDomain,
  fields: Map<string, string>,
): string | null {
  const keys = fieldKeysForDomain(domain);
  const source = lastPopulated(db, domain, keys);
  if (source === null) return null;
  const previousFields = snapshotFields(db, source.snapshot_id);
  let carriedAny = false;
  for (const key of keys) {
    const text = previousFields.get(key);
    if (text !== undefined) {
      fields.set(key, text);
      carriedAny = true;
    }
  }
  return carriedAny ? source.observation_id : null;
}

function snapshotFields(db: SqliteDriver, snapshotId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of db.all(
    'SELECT field_key, value_text FROM snapshot_fields WHERE snapshot_id = ?',
    snapshotId,
  )) {
    out.set(String(row['field_key']), String(row['value_text']));
  }
  return out;
}

function sameFields(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

// Snapshots reference a source row; DMA data has no file on disk, so a single
// synthetic source stands in and keeps provenance queryable.
export function dmaPseudoSourceId(db: SqliteDriver, now: Date): string {
  const existing = db.get(
    "SELECT id FROM sources WHERE kind = 'manual' AND label = 'LinkedIn DMA API'",
  );
  if (existing) return String(existing['id']);
  const id = newId('src');
  db.run(
    `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at, enabled_at)
     VALUES (?, 'manual', 'linkedin://dma', 'LinkedIn DMA API', 'personal_doc', 'enabled', ?, ?)`,
    id,
    now.toISOString(),
    now.toISOString(),
  );
  return id;
}

/**
 * Persists one observation, and a snapshot only if the rendered profile
 * actually differs from the one the previous observation left behind.
 *
 * Must be called from inside the caller's write transaction. It performs no
 * network work, so it is safe under withWriteTx's re-run-on-busy contract.
 */
export function recordObservation(
  db: SqliteDriver,
  input: RecordObservationInput,
): ObservationRecord {
  return withWriteTx(db, () => {
    const previous = previousObservation(db);
    const contentFingerprint = fingerprintObservation(input.observations);

    // Per-domain history is read before anything is written, so both the
    // identity test and the raw-storage decision see the state as it was.
    const holders = new Map<string, ReturnType<typeof lastRawHolder>>();
    for (const observation of input.observations) {
      holders.set(observation.domain, lastRawHolder(db, observation.domain));
    }

    const fields = new Map<string, string>();
    const results: DomainResultRecord[] = [];

    for (const observation of input.observations) {
      const domain = observation.domain;
      let carriedFrom: string | null = null;

      if (isProfileSnapshotDomain(domain)) {
        const rendered =
          observation.status === 'populated'
            ? renderProfileDomain(domain, observation.rows, input.locale)
            : [];
        for (const field of rendered) fields.set(field.key, field.text);
        // Carry forward whenever this read produced no rendering — not only
        // when LinkedIn answered with nothing. A domain can come back
        // "populated" and still render to nothing if none of its columns are
        // recognisable, and dropping the field then would read downstream as
        // "the member deleted this section": latestSnapshot() is the default
        // base for linkedin_profile_diff and linkedin_changeset_generate.
        // Keeping the last rendering we genuinely saw, stamped, is the lesser
        // lie — and the stamp forces the verdict away from "complete".
        if (rendered.length === 0) carriedFrom = carryForward(db, domain, fields);
      }

      results.push({
        domain,
        status: observation.status,
        row_count: observation.row_count,
        fingerprint: observation.fingerprint,
        failure_reason: observation.failure_reason ?? null,
        carried_forward_from: carriedFrom,
      });
    }

    // Domains this read did not ask for still belong to the profile. Building
    // the snapshot from the requested subset alone would publish a truncated
    // profile as the newest version — and latestSnapshot() is the default base
    // for linkedin_profile_diff and linkedin_changeset_generate, so a one-domain
    // read would have them conclude the member deleted everything else.
    const observedDomains = new Set(input.observations.map((o) => o.domain));
    const carriedNotRequested: string[] = [];
    for (const domain of PROFILE_SNAPSHOT_DOMAINS) {
      if (observedDomains.has(domain)) continue;
      if (carryForward(db, domain, fields) !== null) carriedNotRequested.push(domain);
    }

    // "Nothing changed" is decided domain by domain, not by comparing one
    // whole-read fingerprint to the last one. A single domain that 429s would
    // otherwise change the read-level fingerprint and hide the very thing this
    // is for — LinkedIn's Snapshot serving the same bytes while its Changelog
    // already knows an edit happened.
    // Profile domains only. MEMBER_SHARE_INFO is in the default set, so
    // including it meant that publishing a post moved the read-level identity
    // and re-anchored the freshness baseline past a pending profile edit,
    // silencing a lag that was still happening.
    let comparable = 0;
    let differing = 0;
    const unchangedDomains: string[] = [];
    const changedDomains: string[] = [];
    for (const observation of input.observations) {
      if (!isProfileSnapshotDomain(observation.domain)) continue;
      if (observation.status !== 'populated' && observation.status !== 'empty_or_not_ready') {
        continue;
      }
      const holder = holders.get(observation.domain) ?? null;
      if (holder === null || holder.fingerprint === null) continue;
      comparable += 1;
      if (holder.fingerprint !== observation.fingerprint) {
        differing += 1;
        changedDomains.push(observation.domain);
      } else {
        unchangedDomains.push(observation.domain);
      }
    }
    // Zero comparable domains is "unknown", not "changed" — see
    // comparable_domain_count, which is what the report uses to decide whether
    // it may claim anything about change at all.
    const contentIdentical = comparable > 0 && differing === 0;

    // Reuse the previous snapshot when the rendered profile is byte-identical.
    // The comparison is on the rendering rather than on the raw fingerprint, so
    // a change LinkedIn made in a column this product does not render does not
    // manufacture a profile version that nothing can tell apart from the last.
    let snapshotId: string | null = previous?.snapshot_id ?? null;
    let snapshotCreated = false;
    const existingFields =
      snapshotId !== null ? snapshotFields(db, snapshotId) : new Map<string, string>();
    if (snapshotId === null || !sameFields(fields, existingFields)) {
      snapshotId = fields.size > 0 ? writeSnapshot(db, fields, input.observedAt) : null;
      snapshotCreated = snapshotId !== null;
    }

    const observationId = newId('dmo');
    db.run(
      `INSERT INTO dma_snapshot_observations
       (id, snapshot_id, requested_at, request_completed_at, observed_at,
        content_fingerprint, previous_observation_id, content_identical,
        changelog_cursor_ms, newest_profile_event_captured_ms,
        newest_profile_event_processed_ms, requested_domains_json, backfilled,
        retention_class, comparable_domain_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'durable_dma', ?)`,
      observationId,
      snapshotId,
      input.requestedAt.toISOString(),
      input.requestCompletedAt.toISOString(),
      input.observedAt.toISOString(),
      contentFingerprint,
      previous?.id ?? null,
      contentIdentical ? 1 : 0,
      input.changelogCursorMs,
      input.newestProfileEventCapturedMs,
      input.newestProfileEventProcessedMs,
      canonicalJson([...input.requestedDomains] as Jsonish),
      comparable,
    );

    for (const observation of input.observations) {
      const result = results.find((r) => r.domain === observation.domain)!;
      // Bytes are written once per distinct content. An unchanged domain — the
      // common case, and the exact case that made this feature necessary —
      // points at the observation that still holds them.
      const holder = holders.get(observation.domain) ?? null;
      const unchanged =
        holder !== null &&
        observation.fingerprint !== null &&
        holder.fingerprint === observation.fingerprint &&
        holder.holder !== null;
      // Only what LinkedIn actually answered is stored. A failed domain has no
      // rows, and a pagination-incomplete one had its rows deliberately
      // discarded as unprovable — recording `[]` for either would be
      // indistinguishable from a domain that genuinely returned nothing.
      const answered =
        observation.status === 'populated' || observation.status === 'empty_or_not_ready';
      const storeRaw = answered && !unchanged;
      db.run(
        `INSERT INTO dma_snapshot_domain_results
         (observation_id, domain, status, row_count, fingerprint, failure_reason,
          raw_json, raw_same_as_observation_id, carried_forward_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observationId,
        observation.domain,
        observation.status,
        observation.row_count,
        observation.fingerprint,
        result.failure_reason,
        storeRaw ? canonicalJson(observation.rows as Jsonish) : null,
        unchanged ? holder.holder : null,
        result.carried_forward_from,
      );
    }

    return {
      id: observationId,
      snapshot_id: snapshotId,
      snapshot_created: snapshotCreated,
      requested_at: input.requestedAt.toISOString(),
      request_completed_at: input.requestCompletedAt.toISOString(),
      observed_at: input.observedAt.toISOString(),
      content_fingerprint: contentFingerprint,
      previous_observation_id: previous?.id ?? null,
      previous_content_fingerprint: previous?.content_fingerprint ?? null,
      content_identical: contentIdentical,
      comparable_domain_count: comparable,
      unchanged_domains: unchangedDomains,
      changed_domains: changedDomains,
      changelog_cursor_ms: input.changelogCursorMs,
      newest_profile_event_captured_ms: input.newestProfileEventCapturedMs,
      newest_profile_event_processed_ms: input.newestProfileEventProcessedMs,
      requested_domains: [...input.requestedDomains],
      domains: results,
      carried_forward_not_requested: carriedNotRequested,
      fields: Object.fromEntries(fields),
    };
  });
}

function writeSnapshot(db: SqliteDriver, fields: Map<string, string>, now: Date): string {
  return withWriteTx(db, () => {
    const version =
      Number(db.get('SELECT COALESCE(MAX(version), 0) AS v FROM linkedin_snapshots')?.['v'] ?? 0) +
      1;
    const id = newId('snp');
    db.run(
      `INSERT INTO linkedin_snapshots
       (id, source_kind, source_id, taken_at, imported_at, retention_class, version)
       VALUES (?, 'dma_snapshot', ?, NULL, ?, 'durable_dma', ?)`,
      id,
      dmaPseudoSourceId(db, now),
      now.toISOString(),
      version,
    );
    for (const [key, text] of fields) {
      // raw_json stays null on this lane. Nothing reads that column, and the
      // rows it used to hold are already stored canonically, once per distinct
      // content, in dma_snapshot_domain_results.
      db.run(
        `INSERT INTO snapshot_fields (snapshot_id, field_key, value_text, char_count, raw_json)
         VALUES (?, ?, ?, ?, NULL)`,
        id,
        key,
        text,
        text.length,
      );
    }
    return id;
  });
}

export function setObservationFreshness(
  db: SqliteDriver,
  observationId: string,
  status: string,
): void {
  db.run(
    'UPDATE dma_snapshot_observations SET freshness_status = ? WHERE id = ?',
    status,
    observationId,
  );
}

export interface DmaObservationRow {
  id: string;
  snapshot_id: string | null;
  requested_at: string;
  request_completed_at: string | null;
  observed_at: string;
  content_fingerprint: string | null;
  content_identical: boolean;
  freshness_status: string | null;
  backfilled: boolean;
}

function toSummary(row: Record<string, unknown>): DmaObservationRow {
  return {
    id: String(row['id']),
    snapshot_id: (row['snapshot_id'] as string | null) ?? null,
    requested_at: String(row['requested_at']),
    request_completed_at: (row['request_completed_at'] as string | null) ?? null,
    observed_at: String(row['observed_at']),
    content_fingerprint: (row['content_fingerprint'] as string | null) ?? null,
    content_identical: Number(row['content_identical']) === 1,
    freshness_status: (row['freshness_status'] as string | null) ?? null,
    backfilled: Number(row['backfilled']) === 1,
  };
}

export function latestDmaObservation(db: SqliteDriver): DmaObservationRow | null {
  const row = db.get('SELECT * FROM dma_snapshot_observations ORDER BY seq DESC LIMIT 1');
  return row ? toSummary(row) : null;
}
