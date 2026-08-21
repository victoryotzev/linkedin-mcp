import { newId } from '@linkedin-mcp/shared';
import type { SqliteDriver } from '@linkedin-mcp/db';

// Direct-row seeding for unit tests that need sources/artifacts without
// running the import pipeline.
export function seedSourceAndArtifact(
  db: SqliteDriver,
  opts: { trust?: 'personal_doc' | 'own_repo' | 'local_clone_reference'; label?: string } = {},
): { sourceId: string; artifactId: string } {
  const sourceId = newId('src');
  const runId = newId('run');
  const artifactId = newId('art');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
     VALUES (?, 'repo', ?, ?, ?, 'enabled', ?)`,
    sourceId,
    `C:\\fixture\\${sourceId}`,
    opts.label ?? 'fixture source',
    opts.trust ?? 'own_repo',
    now,
  );
  db.run(
    'INSERT INTO import_runs (id, source_id, started_at) VALUES (?, ?, ?)',
    runId,
    sourceId,
    now,
  );
  db.run(
    `INSERT INTO artifacts (id, source_id, source_relpath, sha256, size_bytes, mime, imported_at, import_run_id)
     VALUES (?, ?, 'README.md', ?, 100, 'text/markdown', ?, ?)`,
    artifactId,
    sourceId,
    'f'.repeat(64),
    now,
    runId,
  );
  return { sourceId, artifactId };
}
