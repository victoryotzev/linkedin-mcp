import { withWriteTx, type ArtifactStore, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';

export interface PurgeResult {
  artifact_id: string;
  source_relpath: string;
  extractions_removed: number;
  posts_unlinked: number;
  observations_unlinked: number;
  bytes_deleted: boolean;
}

// Targeted artifact purge. Guardrails:
//   - refuses while any non-rejected claim cites the artifact (evidence must
//     be resolved first — purging cited evidence would strand public claims)
//   - clears every foreign key onto artifacts, in dependency order
//   - deletes the stored bytes only when no other artifact row shares the
//     hash (the store is content-addressed, so duplicates are one file)
//
// Five tables reference artifacts(id): extractions, claim_evidence,
// artifacts.superseded_by, published_posts.artifact_id and
// analytics_observations.provenance_artifact_id. Missing any one of them makes
// the whole purge fail closed with a raw SQLite FK error, because
// `PRAGMA foreign_keys = ON` is set for every connection.
export function purgeArtifact(
  db: SqliteDriver,
  store: ArtifactStore,
  artifactId: string,
  confirm: boolean,
): PurgeResult {
  if (!confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'purging evidence is destructive and irreversible: pass confirm: true',
    );
  }
  // The byte delete happens AFTER the transaction commits, never inside it.
  // withWriteTx re-runs its body on SQLITE_BUSY and rolls back on throw; a
  // filesystem unlink obeys neither, so a retry would delete bytes for a
  // transaction that never committed, and a rollback would leave rows pointing
  // at a file that is already gone.
  const pending = withWriteTx(db, () => {
    const artifact = db.get('SELECT * FROM artifacts WHERE id = ?', artifactId);
    if (!artifact) throw new DomainError('NOT_FOUND', `artifact ${artifactId} not found`);

    const citing = db.all(
      `SELECT c.id, c.state FROM claim_evidence ce
       JOIN claims c ON c.id = ce.claim_id
       WHERE ce.artifact_id = ? AND c.state != 'rejected'`,
      artifactId,
    );
    if (citing.length > 0) {
      throw new DomainError(
        'INVALID_INPUT',
        `artifact ${artifactId} is cited by ${citing.length} live claim(s): ${citing
          .map((c) => `${String(c['id'])} (${String(c['state'])})`)
          .join(', ')}; resolve those claims before purging`,
      );
    }

    const sha256 = String(artifact['sha256']);

    // claim_evidence BEFORE extractions: claim_evidence.extraction_id is a
    // foreign key onto extractions(id), so deleting the extractions first
    // aborts the whole purge for any artifact whose rejected claims recorded an
    // extraction — the member resolves the claims exactly as instructed and the
    // purge still refuses, with an opaque SQLite error.
    db.run('DELETE FROM claim_evidence WHERE artifact_id = ?', artifactId);
    const extractions = db.run('DELETE FROM extractions WHERE artifact_id = ?', artifactId);

    // These two hold the member's own durable data (their post history, their
    // transcribed metrics), not the artifact. Unlink rather than delete — but
    // report the counts, because losing provenance silently is its own harm.
    const posts = db.run(
      'UPDATE published_posts SET artifact_id = NULL WHERE artifact_id = ?',
      artifactId,
    );
    const observations = db.run(
      'UPDATE analytics_observations SET provenance_artifact_id = NULL WHERE provenance_artifact_id = ?',
      artifactId,
    );

    // Re-link the supersede chain through the hole rather than blanking it.
    // Setting predecessors to NULL promotes them to 'active', and
    // idx_artifacts_active_relpath is UNIQUE on (source_id, source_relpath)
    // WHERE superseded_by IS NULL — so purging a mid-chain artifact would
    // create a second active row for the same path and abort on the index.
    db.run(
      'UPDATE artifacts SET superseded_by = ? WHERE superseded_by = ?',
      (artifact['superseded_by'] as string | null) ?? null,
      artifactId,
    );
    db.run('DELETE FROM artifacts WHERE id = ?', artifactId);

    const stillReferenced = db.get('SELECT 1 AS x FROM artifacts WHERE sha256 = ?', sha256);

    return {
      sha256,
      delete_bytes: !stillReferenced,
      result: {
        artifact_id: artifactId,
        source_relpath: String(artifact['source_relpath']),
        extractions_removed: Number(extractions.changes),
        posts_unlinked: Number(posts.changes),
        observations_unlinked: Number(observations.changes),
        bytes_deleted: false,
      } satisfies PurgeResult,
    };
  });

  return {
    ...pending.result,
    bytes_deleted: pending.delete_bytes ? store.delete(pending.sha256) : false,
  };
}
