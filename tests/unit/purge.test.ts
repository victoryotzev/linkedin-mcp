import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { listArtifacts, proposeClaim, purgeArtifact, rejectClaim } from '@linkedin-mcp/domain';
import { isSensitiveExportFile } from '@linkedin-mcp/importers';
import { DomainError } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let store: ArtifactStore;
let artifactId: string;
let sha256: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-purge-'));
  const opened = openDatabase(join(dir, 't.sqlite3'));
  db = opened.db;
  migrate(db);
  store = new ArtifactStore(join(dir, 'artifacts'));
  ({ artifactId } = seedSourceAndArtifact(db));
  const put = store.put(Buffer.from('sensitive bytes'));
  sha256 = put.sha256;
  db.run('UPDATE artifacts SET sha256 = ? WHERE id = ?', sha256, artifactId);
  db.run(
    `INSERT INTO extractions (id, artifact_id, parser_name, parser_version, status, text, created_at)
     VALUES ('ext_x', ?, 'text', 1, 'ok', 'derived text', ?)`,
    artifactId,
    new Date().toISOString(),
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('purgeArtifact', () => {
  it('requires explicit confirmation', () => {
    expect(() => purgeArtifact(db, store, artifactId, false)).toThrowError(DomainError);
  });

  it('refuses while a live claim cites the artifact, and allows it once rejected', () => {
    const claim = proposeClaim(db, {
      statement: 'A claim citing the artifact about to be purged.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    try {
      purgeArtifact(db, store, artifactId, true);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('INVALID_INPUT');
      expect((err as DomainError).message).toContain(claim.id);
    }

    rejectClaim(db, {
      claim_id: claim.id,
      reason: 'evidence withdrawn',
      confirm: true,
      reviewer: 'test',
    });
    const result = purgeArtifact(db, store, artifactId, true);
    expect(result.bytes_deleted).toBe(true);
    expect(store.has(sha256)).toBe(false);
    expect(listArtifacts(db, { include_superseded: true }, false)).toHaveLength(0);
  });

  it('keeps shared bytes when another artifact references the same hash', () => {
    const other = seedSourceAndArtifact(db);
    db.run('UPDATE artifacts SET sha256 = ? WHERE id = ?', sha256, other.artifactId);
    const result = purgeArtifact(db, store, artifactId, true);
    expect(result.bytes_deleted).toBe(false);
    expect(store.has(sha256)).toBe(true);
  });

  // Five tables carry a foreign key onto artifacts(id). Missing any one makes
  // the purge abort with a raw SQLite FK error, so the member does exactly what
  // the blocker told them to do and the sensitive bytes still stay on disk.
  // The pre-existing tests all used evidence WITHOUT an extraction_id, which is
  // why this survived.
  it('purges evidence that recorded an extraction_id', () => {
    const claim = proposeClaim(db, {
      statement: 'A claim whose evidence points at a specific extraction.',
      evidence: [{ artifact_id: artifactId, extraction_id: 'ext_x', location: {} }],
      method: 'manual',
    });
    rejectClaim(db, {
      claim_id: claim.id,
      reason: 'evidence withdrawn',
      confirm: true,
      reviewer: 'test',
    });

    const result = purgeArtifact(db, store, artifactId, true);
    expect(result.extractions_removed).toBe(1);
    expect(store.has(sha256)).toBe(false);
    expect(
      db.get('SELECT 1 AS x FROM claim_evidence WHERE artifact_id = ?', artifactId),
    ).toBeUndefined();
  });

  it('unlinks published posts and observations instead of failing on their foreign keys', () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO published_posts (id, share_url, posted_at, commentary, char_count, artifact_id, imported_at)
       VALUES ('pp_1', NULL, ?, 'a post derived from the purged export', 36, ?, ?)`,
      now,
      artifactId,
      now,
    );
    db.run(
      `INSERT INTO analytics_observations
         (id, subject_type, subject_ref, metric, value, observed_at, source, provenance_artifact_id, imported_at)
       VALUES ('obs_1', 'post', 'pp_1', 'impressions', 410, ?, 'manual_import', ?, ?)`,
      now,
      artifactId,
      now,
    );

    const result = purgeArtifact(db, store, artifactId, true);
    expect(result.posts_unlinked).toBe(1);
    expect(result.observations_unlinked).toBe(1);
    // The member's own post history survives the purge of the file it came from.
    expect(
      db.get('SELECT artifact_id FROM published_posts WHERE id = ?', 'pp_1')?.['artifact_id'],
    ).toBeNull();
    expect(
      db.get('SELECT provenance_artifact_id FROM analytics_observations WHERE id = ?', 'obs_1')?.[
        'provenance_artifact_id'
      ],
    ).toBeNull();
  });

  it('re-links the supersede chain through a purged mid-chain artifact', () => {
    // old -> middle -> head, all at the same relpath. Blanking the predecessor
    // instead of re-linking promotes it to active and collides with `head` on
    // idx_artifacts_active_relpath (UNIQUE where superseded_by IS NULL).
    const sourceId = String(
      db.get('SELECT source_id FROM artifacts WHERE id = ?', artifactId)!['source_id'],
    );
    const runId = String(
      db.get('SELECT import_run_id FROM artifacts WHERE id = ?', artifactId)!['import_run_id'],
    );
    const now = new Date().toISOString();
    const add = (id: string, superseded: string | null) =>
      db.run(
        `INSERT INTO artifacts (id, source_id, source_relpath, sha256, size_bytes, mime, imported_at, import_run_id, superseded_by)
         VALUES (?, ?, 'README.md', ?, 100, 'text/markdown', ?, ?, ?)`,
        id,
        sourceId,
        id.padEnd(64, 'a'),
        now,
        runId,
        superseded,
      );
    // artifactId is the current active head; demote it and build a chain.
    add('art_middle', artifactId);
    add('art_old', 'art_middle');

    const result = purgeArtifact(db, store, 'art_middle', true);
    expect(result.artifact_id).toBe('art_middle');
    expect(
      db.get('SELECT superseded_by FROM artifacts WHERE id = ?', 'art_old')?.['superseded_by'],
    ).toBe(artifactId);
    // Still exactly one active artifact for that path.
    expect(
      db.all(
        "SELECT id FROM artifacts WHERE source_relpath = 'README.md' AND superseded_by IS NULL",
      ),
    ).toHaveLength(1);
  });
});

describe('sensitive export detection', () => {
  it('matches member-id-suffixed and space-separated sensitive files', () => {
    for (const name of [
      'Logins.csv',
      'Security Challenges.csv',
      'Ads Clicked.csv',
      'Inferences_about_you.csv',
      'Votes_836880749.csv',
      'Reactions_836880749.csv',
      'Member_Follows_836880749.csv',
      'messages.csv',
      'Connections.csv',
      'folder/Email Addresses.csv',
    ]) {
      expect(isSensitiveExportFile(name), name).toBe(true);
    }
  });

  it('keeps the profile, career and post-history files', () => {
    for (const name of [
      'Profile.csv',
      'Positions.csv',
      'Education.csv',
      'Skills.csv',
      'Shares_836880749.csv',
      'Endorsement_Received_Info.csv',
      'Verifications/Verifications.csv',
    ]) {
      expect(isSensitiveExportFile(name), name).toBe(false);
    }
  });
});
