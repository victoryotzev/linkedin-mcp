import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import { appendAuditEvent, type AuditActor } from './auditService.ts';

// Deletion for everything the EU Data Portability lane stored.
//
// The portability terms permit storing Member Portability Data with consent and
// require deleting all of it on request. Until this existed the only way to
// honour that was to destroy the whole database, which also takes the member's
// claims, drafts, approvals and audit history with it — so the obligation could
// not actually be met without losing unrelated work.
//
// Two shapes, because two different things are being asked for:
//   - prune: drop history older than a cutoff to bound growth, keeping the
//     current observed profile intact;
//   - purge: delete the lane outright, as if it had never been synced.
//
// What is never deleted here: canonical profile revisions, claims, drafts,
// approvals and the audit chain. None of those are Portability Data — they are
// the member's own work, and several are append-only by design.

/** Tables holding rows this lane owns, in the order they must be emptied. */
export interface DmaLaneFootprint {
  changelog_events: number;
  snapshot_observations: number;
  snapshot_domain_results: number;
  dma_snapshots: number;
  snapshot_fields: number;
  published_posts: number;
  /** Bytes of raw upstream payload currently stored, approximately. */
  raw_payload_bytes: number;
}

export interface DmaPurgeResult {
  mode: 'prune' | 'purge';
  before: string | null;
  deleted: DmaLaneFootprint;
  /**
   * DMA snapshots deliberately kept, with the reason. A snapshot a change set
   * is based on cannot be deleted without deleting that change set, which is
   * the member's own work product rather than Portability Data.
   */
  retained_snapshots: Array<{ snapshot_id: string; reason: string }>;
  /**
   * True only when the lane holds no LinkedIn-derived data afterwards. A purge
   * that had to keep a snapshot has NOT fully honoured a deletion request, and
   * saying otherwise would be the one thing this feature exists to avoid.
   */
  fully_deleted: boolean;
  /** True when the changelog cursor was reset, so the next sync re-reads. */
  cursor_reset: boolean;
  purged_at: string;
}

function count(db: SqliteDriver, sql: string, ...params: string[]): number {
  return Number(db.get(sql, ...params)?.['n'] ?? 0);
}

/** What the lane currently occupies. Read-only; safe to call any time. */
export function dmaLaneFootprint(db: SqliteDriver): DmaLaneFootprint {
  return {
    changelog_events: count(db, 'SELECT COUNT(*) AS n FROM dma_changelog_events'),
    snapshot_observations: count(db, 'SELECT COUNT(*) AS n FROM dma_snapshot_observations'),
    snapshot_domain_results: count(db, 'SELECT COUNT(*) AS n FROM dma_snapshot_domain_results'),
    dma_snapshots: count(
      db,
      "SELECT COUNT(*) AS n FROM linkedin_snapshots WHERE source_kind = 'dma_snapshot'",
    ),
    snapshot_fields: count(
      db,
      `SELECT COUNT(*) AS n FROM snapshot_fields
        WHERE snapshot_id IN (SELECT id FROM linkedin_snapshots WHERE source_kind = 'dma_snapshot')`,
    ),
    published_posts: count(
      db,
      "SELECT COUNT(*) AS n FROM published_posts WHERE retention_class = 'durable_dma'",
    ),
    // CAST AS BLOB because LENGTH() on TEXT counts characters, not bytes, and
    // this lane routinely stores Cyrillic — which would report half the real
    // size in a field labelled bytes.
    raw_payload_bytes:
      count(
        db,
        'SELECT COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0) AS n FROM dma_changelog_events',
      ) +
      count(
        db,
        'SELECT COALESCE(SUM(LENGTH(CAST(raw_json AS BLOB))), 0) AS n FROM dma_snapshot_domain_results',
      ),
  };
}

/**
 * LinkedIn's Changelog retention. Pruning never removes an event newer than
 * this: those are the ones LinkedIn would still serve and the ones the freshness
 * overlay reasons about, so deleting them would blind lag detection without
 * even saving anything permanently. Everything older is pure accumulation —
 * LinkedIn will not serve it again either way — and that is what grows without
 * bound.
 */
const CHANGELOG_RETENTION_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * Absolute instants only. `new Date('2026-08-12T00:00:00')` is interpreted in
 * the host's timezone, so an offset-less string would silently shift the cutoff
 * by the machine's UTC offset and delete a different window than was asked for.
 */
const ABSOLUTE_INSTANT = /([Zz]|[+-]\d{2}:?\d{2})$/;

export interface DmaPurgeOptions {
  /**
   * ISO timestamp. Only rows recorded strictly before it are removed, and the
   * current observed profile is kept whatever its age. Omit to delete the lane
   * outright.
   */
  before?: string;
  confirm: boolean;
  now?: Date;
  actor?: AuditActor;
}

export function purgeDmaLane(db: SqliteDriver, opts: DmaPurgeOptions): DmaPurgeResult {
  if (!opts.confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'deleting portability data is irreversible: pass confirm: true',
      { blockers: ['confirmation_required'] },
    );
  }

  const now = opts.now ?? new Date();
  if (opts.before !== undefined) {
    if (Number.isNaN(Date.parse(opts.before)) || !ABSOLUTE_INSTANT.test(opts.before.trim())) {
      throw new DomainError(
        'INVALID_INPUT',
        `before must be an ISO timestamp with an explicit UTC offset, e.g. 2026-07-01T00:00:00Z; got ${opts.before}`,
        { blockers: ['bad_cutoff'] },
      );
    }
    // A future cutoff would make pruning delete everything, which is the other
    // operation — and that one requires an exact confirmation phrase. Without
    // this, the phrase gate is bypassable by passing a cutoff of 2099.
    if (Date.parse(opts.before) > now.getTime()) {
      throw new DomainError(
        'INVALID_INPUT',
        'before must be in the past; to delete the whole lane use the purge mode, which requires its own confirmation phrase',
        { blockers: ['cutoff_in_future'] },
      );
    }
  }
  // Normalized to the exact format the stored columns use. These comparisons
  // are lexical on TEXT, so `2026-07-01T00:00:00Z` and `2026-07-01T00:00:00.000Z`
  // are different cutoffs unless both sides are written the same way.
  const before = opts.before === undefined ? null : new Date(opts.before).toISOString();
  const mode = before === null ? 'purge' : 'prune';

  return withWriteTx(db, () => {
    const retained: DmaPurgeResult['retained_snapshots'] = [];
    const bytesBefore = dmaLaneFootprint(db).raw_payload_bytes;

    // --- observations and their per-domain rows ----------------------------
    // Observations go first so the snapshot pass below can see which snapshots
    // are still referenced. The newest observation is always kept: it is the
    // record of the current observed profile, and deleting it leaves the
    // retained snapshot orphaned, the next read with no previous observation,
    // and the freshness baseline with nothing to anchor on — which reports a
    // stale profile as clean.
    const observationWhere =
      before === null
        ? { sql: '1 = 1', params: [] as string[] }
        : {
            sql: `observed_at < ? AND seq <> COALESCE(
                    (SELECT seq FROM dma_snapshot_observations ORDER BY seq DESC LIMIT 1), -1)`,
            params: [before],
          };

    const domainResults = db.run(
      `DELETE FROM dma_snapshot_domain_results
        WHERE observation_id IN (SELECT id FROM dma_snapshot_observations WHERE ${observationWhere.sql})`,
      ...observationWhere.params,
    );
    const observations = db.run(
      `DELETE FROM dma_snapshot_observations WHERE ${observationWhere.sql}`,
      ...observationWhere.params,
    );

    // --- which snapshots may go -------------------------------------------
    // A DMA snapshot is shared by every consecutive observation that returned
    // identical content — the whole reason observations exist as a separate
    // table — so age alone does not make one unused. Anything a surviving
    // observation still points at stays, whatever its imported_at.
    const candidates = db.all(
      before === null
        ? `SELECT id FROM linkedin_snapshots
            WHERE source_kind = 'dma_snapshot'
              AND id NOT IN (SELECT snapshot_id FROM dma_snapshot_observations
                              WHERE snapshot_id IS NOT NULL)
            ORDER BY version`
        : `SELECT id FROM linkedin_snapshots
            WHERE source_kind = 'dma_snapshot' AND imported_at < ?
              AND id <> COALESCE((SELECT id FROM linkedin_snapshots
                                   WHERE source_kind = 'dma_snapshot'
                                   ORDER BY version DESC LIMIT 1), '')
              AND id NOT IN (SELECT snapshot_id FROM dma_snapshot_observations
                              WHERE snapshot_id IS NOT NULL)
            ORDER BY version`,
      ...(before === null ? [] : [before]),
    );

    // Two things pin a snapshot in place, and both are the member's own work
    // rather than Portability Data: a change set is based on it
    // (change_sets.base_snapshot_id is NOT NULL, so deleting the snapshot means
    // deleting the change set), and an applied patch was verified against it
    // (nulling that pointer would send the patch back to "awaiting
    // verification" forever, with no snapshot left to re-verify against).
    const deletable: string[] = [];
    for (const row of candidates) {
      const id = String(row['id']);
      const citedBy = db.get('SELECT id FROM change_sets WHERE base_snapshot_id = ? LIMIT 1', id);
      if (citedBy) {
        retained.push({
          snapshot_id: id,
          reason: `change set ${String(citedBy['id'])} is based on it, and change_sets.base_snapshot_id cannot be null; the LinkedIn-derived field text on this snapshot therefore remains stored. Delete the change set, then run this again.`,
        });
        continue;
      }
      const verifies = db.get(
        'SELECT id FROM field_patches WHERE applied_verified_snapshot_id = ? LIMIT 1',
        id,
      );
      if (verifies) {
        retained.push({
          snapshot_id: id,
          reason: `applied patch ${String(verifies['id'])} was verified against it; clearing that would report the patch as unverified forever. The LinkedIn-derived field text on this snapshot therefore remains stored.`,
        });
        continue;
      }
      deletable.push(id);
    }

    // --- snapshots ---------------------------------------------------------
    let snapshotFields = 0;
    let snapshots = 0;
    if (deletable.length > 0) {
      const snapshotList = deletable.map(() => '?').join(', ');
      snapshotFields = Number(
        db.run(`DELETE FROM snapshot_fields WHERE snapshot_id IN (${snapshotList})`, ...deletable)
          .changes,
      );
      snapshots = Number(
        db.run(`DELETE FROM linkedin_snapshots WHERE id IN (${snapshotList})`, ...deletable)
          .changes,
      );
    }

    // --- changelog ---------------------------------------------------------
    // Pruning stops at LinkedIn's own retention boundary. An event inside the
    // 28-day window is one LinkedIn would still serve and one the freshness
    // overlay reasons about; deleting it while the cursor stays put means it is
    // never re-fetched and a pending edit silently stops being reported. Older
    // events are pure accumulation, and that is the growth worth bounding.
    const eventCutoff =
      before === null
        ? null
        : new Date(
            Math.min(Date.parse(before), now.getTime() - CHANGELOG_RETENTION_MS),
          ).toISOString();
    const events = db.run(
      eventCutoff === null
        ? 'DELETE FROM dma_changelog_events'
        : 'DELETE FROM dma_changelog_events WHERE received_at < ?',
      ...(eventCutoff === null ? [] : [eventCutoff]),
    );

    // --- own post history --------------------------------------------------
    // Only a full purge touches it. durable_dma posts are stamped with the sync
    // time, not the post date, so pruning by the cutoff would delete an archive
    // spanning years the first time someone pruned a database that had not been
    // synced recently — and draft validation reads this table to catch
    // near-duplicates of what the member already published.
    const postsDeleted =
      before === null
        ? Number(
            db.run("DELETE FROM published_posts WHERE retention_class = 'durable_dma'").changes,
          )
        : 0;

    // --- repair every pointer the deletions could have left dangling -------
    // None of these are foreign keys, so SQLite will not catch them. A dangling
    // previous_observation_id is the dangerous one: the freshness baseline
    // resolves it with a subquery, and a miss silently turns lag detection off
    // and reports the profile as clean.
    db.run(
      `UPDATE dma_snapshot_observations SET previous_observation_id = NULL
        WHERE previous_observation_id IS NOT NULL
          AND previous_observation_id NOT IN (SELECT id FROM dma_snapshot_observations)`,
    );
    db.run(
      `UPDATE dma_snapshot_domain_results SET raw_same_as_observation_id = NULL
        WHERE raw_same_as_observation_id IS NOT NULL
          AND raw_same_as_observation_id NOT IN (SELECT id FROM dma_snapshot_observations)`,
    );
    db.run(
      `UPDATE dma_snapshot_domain_results SET carried_forward_from = NULL
        WHERE carried_forward_from IS NOT NULL
          AND carried_forward_from NOT LIKE 'snapshot:%'
          AND carried_forward_from NOT IN (SELECT id FROM dma_snapshot_observations)`,
    );

    // --- cursor ------------------------------------------------------------
    // A full purge puts the lane back to never-synced, so the cursor goes with
    // it: leaving it would make the next sync fetch only events newer than data
    // that no longer exists. Pruning old rows leaves the cursor alone, because
    // it tracks the newest event and pruning only removes older ones.
    let cursorReset = false;
    if (before === null) {
      cursorReset = Number(db.run('DELETE FROM dma_changelog_watermarks').changes) > 0;
      // Every row, not just the changelog's: the per-domain notes record what
      // each domain last did and name the observations they carried forward
      // from, so leaving them would keep describing data that is gone.
      db.run('DELETE FROM dma_sync_state');
    }

    const deleted: DmaLaneFootprint = {
      changelog_events: Number(events.changes),
      snapshot_observations: Number(observations.changes),
      snapshot_domain_results: Number(domainResults.changes),
      dma_snapshots: snapshots,
      snapshot_fields: snapshotFields,
      published_posts: postsDeleted,
      // Measured, not assumed: the difference between what the lane held before
      // and what it holds now.
      raw_payload_bytes: bytesBefore - dmaLaneFootprint(db).raw_payload_bytes,
    };

    // Counts only. Naming what was deleted would put the deleted data back into
    // the audit log, which is exported and never purged.
    appendAuditEvent(db, {
      event_type: 'dma.purge',
      actor: opts.actor ?? 'mcp_host',
      subject_type: 'dma_lane',
      payload: {
        mode,
        before,
        cursor_reset: cursorReset,
        retained_snapshot_count: retained.length,
        fully_deleted: before === null && retained.length === 0,
        ...deleted,
      },
    });

    return {
      mode,
      before,
      deleted,
      retained_snapshots: retained,
      fully_deleted: before === null && retained.length === 0,
      cursor_reset: cursorReset,
      purged_at: now.toISOString(),
    };
  });
}
