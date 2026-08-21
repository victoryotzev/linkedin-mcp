import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { withWriteTx, type ArtifactStore, type SqliteDriver } from '@linkedin-mcp/db';
import {
  DEFAULT_PII_SKIPLIST,
  assertContained,
  extractFromBytes,
  isSensitiveExportFile,
  mimeFor,
  readZipEntries,
  scanRepo,
} from '@linkedin-mcp/importers';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { getSettingOrDefault } from './settingsService.ts';
import { getSource, type Source } from './sourceService.ts';

export interface ImportReject {
  relpath: string;
  reason: string;
}

export interface ImportRunReport {
  run_id: string;
  source_id: string;
  dry_run: boolean;
  files_seen: number;
  files_imported: number;
  files_skipped_dup: number;
  files_rejected: number;
  rejects: ImportReject[];
  new_artifact_ids: string[];
}

interface CandidateFile {
  relpath: string;
  mtime: string | null;
  /**
   * Reads the bytes on demand. Candidates used to carry their bytes eagerly, so
   * collectCandidates held every matched file in memory at once before a single
   * artifact was written — a repo scan of 1,600 files materialised all of them.
   * With a loader, at most one file's bytes are resident at a time and the
   * size ceiling is still enforced before anything is read.
   */
  load: () => Buffer;
}

const DEFAULT_MAX_FILE_MB = 50;

const FOLDER_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  'out',
  'target',
  '.pytest_cache',
]);

// Copy-only, immutable-import pipeline. Originals are read once and copied
// into the content-addressed store; the user's files are never moved, edited,
// or re-read after import. Per-file isolation: one bad file becomes a reject
// row, the run continues.
export async function runImport(
  db: SqliteDriver,
  store: ArtifactStore,
  sourceId: string,
  opts: { dryRun?: boolean; subpath?: string } = {},
): Promise<ImportRunReport> {
  const source = getSource(db, sourceId);
  if (source.status !== 'enabled') {
    throw new DomainError(
      'INVALID_INPUT',
      `source ${sourceId} is '${source.status}'; explicitly enable it through MCP, the dashboard, or control CLI before importing`,
      { blockers: ['source_not_enabled'] },
    );
  }
  const dryRun = opts.dryRun ?? false;
  const maxFileBytes =
    getSettingOrDefault(db, 'importer.max_file_mb', DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  const piiSkiplist = getSettingOrDefault(db, 'importer.pii_skiplist', [...DEFAULT_PII_SKIPLIST]);

  const runId = newId('run');
  const startedAt = new Date().toISOString();
  withWriteTx(db, () => {
    db.run(
      'INSERT INTO import_runs (id, source_id, started_at, dry_run) VALUES (?, ?, ?, ?)',
      runId,
      sourceId,
      startedAt,
      dryRun ? 1 : 0,
    );
  });

  const rejects: ImportReject[] = [];
  const newArtifactIds: string[] = [];
  let seen = 0;
  let imported = 0;
  let dupSkipped = 0;

  const candidates = await collectCandidates(
    source,
    opts.subpath,
    maxFileBytes,
    piiSkiplist,
    rejects,
  );

  for (const candidate of candidates) {
    seen += 1;
    try {
      const outcome = await importOne(db, store, source, runId, candidate, dryRun);
      if (outcome === 'imported') {
        imported += 1;
      } else {
        dupSkipped += 1;
      }
      if (outcome === 'imported' && !dryRun) {
        const row = db.get(
          'SELECT id FROM artifacts WHERE source_id = ? AND source_relpath = ? AND superseded_by IS NULL',
          source.id,
          candidate.relpath,
        );
        if (row) newArtifactIds.push(String(row['id']));
      }
    } catch (err) {
      rejects.push({
        relpath: candidate.relpath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finishedAt = new Date().toISOString();
  withWriteTx(db, () => {
    db.run(
      `UPDATE import_runs
       SET finished_at = ?, files_seen = ?, files_imported = ?, files_skipped_dup = ?, files_rejected = ?, rejects_json = ?
       WHERE id = ?`,
      finishedAt,
      seen,
      imported,
      dupSkipped,
      rejects.length,
      JSON.stringify(rejects.slice(0, 200)),
      runId,
    );
    if (!dryRun) {
      db.run('UPDATE sources SET last_import_at = ? WHERE id = ?', finishedAt, sourceId);
    }
  });

  return {
    run_id: runId,
    source_id: sourceId,
    dry_run: dryRun,
    files_seen: seen,
    files_imported: imported,
    files_skipped_dup: dupSkipped,
    files_rejected: rejects.length,
    rejects,
    new_artifact_ids: newArtifactIds,
  };
}

export interface IngestBytesInput {
  source_id: string;
  /** Stored as the artifact's relpath, so it must look like a file name. */
  filename: string;
  bytes: Buffer;
}

/**
 * Imports bytes that never came from a directory scan — an upload, or text the
 * member typed about themselves.
 *
 * This deliberately builds a synthetic candidate and hands it to the same
 * `importOne` the directory walk uses, rather than writing a second ingest
 * path. Redaction, the duplicate check, the extraction ceiling and the artifact
 * row are therefore not merely equivalent to the scanned path: they are the
 * same code. A parallel implementation here would be a second place for the
 * redactor to be forgotten.
 *
 * The size ceiling is enforced before anything is stored, because unlike the
 * directory walk there is no earlier point at which the bytes were measured.
 */
export async function ingestBytes(
  db: SqliteDriver,
  store: ArtifactStore,
  input: IngestBytesInput,
): Promise<ImportRunReport> {
  const source = getSource(db, input.source_id);
  if (source.status !== 'enabled') {
    throw new DomainError(
      'INVALID_INPUT',
      `source ${input.source_id} is '${source.status}'; explicitly enable it before importing`,
      { blockers: ['source_not_enabled'] },
    );
  }

  const relpath = input.filename.trim();
  // The relpath is stored, indexed, and shown. A path separator here would
  // imply a directory structure that does not exist for a virtual source.
  if (relpath === '' || /[\\/]/.test(relpath)) {
    throw new DomainError(
      'INVALID_INPUT',
      'filename must be a single name with no path separators',
    );
  }

  const maxFileBytes =
    getSettingOrDefault(db, 'importer.max_file_mb', DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  if (input.bytes.byteLength === 0) {
    throw new DomainError('INVALID_INPUT', 'refusing to import an empty file');
  }
  if (input.bytes.byteLength > maxFileBytes) {
    throw new DomainError(
      'INVALID_INPUT',
      `file is ${input.bytes.byteLength} bytes, over the ${maxFileBytes}-byte import ceiling`,
      { blockers: ['file_too_large'] },
    );
  }

  const runId = newId('run');
  const startedAt = new Date().toISOString();
  withWriteTx(db, () => {
    db.run(
      'INSERT INTO import_runs (id, source_id, started_at, dry_run) VALUES (?, ?, ?, 0)',
      runId,
      source.id,
      startedAt,
    );
  });

  const rejects: ImportReject[] = [];
  const newArtifactIds: string[] = [];
  let imported = 0;
  let dupSkipped = 0;

  try {
    const outcome = await importOne(
      db,
      store,
      source,
      runId,
      { relpath, mtime: null, load: () => input.bytes },
      false,
    );
    if (outcome === 'imported') {
      imported = 1;
      const row = db.get(
        'SELECT id FROM artifacts WHERE source_id = ? AND source_relpath = ? AND superseded_by IS NULL',
        source.id,
        relpath,
      );
      if (row) newArtifactIds.push(String(row['id']));
    } else {
      dupSkipped = 1;
    }
  } catch (err) {
    rejects.push({ relpath, reason: err instanceof Error ? err.message : String(err) });
  }

  const finishedAt = new Date().toISOString();
  withWriteTx(db, () => {
    db.run(
      `UPDATE import_runs
       SET finished_at = ?, files_seen = 1, files_imported = ?, files_skipped_dup = ?, files_rejected = ?, rejects_json = ?
       WHERE id = ?`,
      finishedAt,
      imported,
      dupSkipped,
      rejects.length,
      JSON.stringify(rejects),
      runId,
    );
    db.run('UPDATE sources SET last_import_at = ? WHERE id = ?', finishedAt, source.id);
  });

  return {
    run_id: runId,
    source_id: source.id,
    dry_run: false,
    files_seen: 1,
    files_imported: imported,
    files_skipped_dup: dupSkipped,
    files_rejected: rejects.length,
    rejects,
    new_artifact_ids: newArtifactIds,
  };
}

async function collectCandidates(
  source: Source,
  subpath: string | undefined,
  maxFileBytes: number,
  piiSkiplist: readonly string[],
  rejects: ImportReject[],
): Promise<CandidateFile[]> {
  switch (source.kind) {
    case 'document': {
      assertUnderSizeCap(source.root_path, maxFileBytes);
      const name = source.root_path.split('\\').pop() ?? 'document';
      return [
        {
          relpath: name,
          mtime: mtimeOf(source.root_path),
          load: () => readBounded(source.root_path, maxFileBytes),
        },
      ];
    }
    case 'linkedin_export': {
      const zipBytes = readBounded(source.root_path, 500 * 1024 * 1024);
      const entries = await readZipEntries(zipBytes);
      const kept: CandidateFile[] = [];
      for (const entry of entries) {
        if (isSensitiveExportFile(entry.relpath, piiSkiplist)) {
          rejects.push({
            relpath: entry.relpath,
            reason:
              'sensitive/PII export file (default skip; override via importer.pii_skiplist setting)',
          });
          continue;
        }
        // ZIP entries are decoded by readZipEntries in one pass, so their bytes
        // are already resident; the loader just hands them over. Ceilings on
        // entry count and total size come from DEFAULT_ZIP_LIMITS.
        const bytes = entry.bytes;
        kept.push({ relpath: entry.relpath, mtime: null, load: () => bytes });
      }
      return kept;
    }
    case 'repo': {
      const scan = scanRepo(source.root_path, maxFileBytes);
      const files: CandidateFile[] = scan.evidenceFiles.map((rel) => {
        const full = assertContained(source.root_path, join(source.root_path, rel));
        return {
          relpath: relative(source.root_path, full),
          mtime: mtimeOf(full),
          // Path captured, bytes read only when this file's turn comes.
          load: () => readBounded(full, maxFileBytes),
        };
      });
      // Deterministic repo stats become a synthetic artifact so scale claims
      // have citable provenance without copying the whole tree.
      const stats = Buffer.from(JSON.stringify(scan.stats, null, 2), 'utf8');
      files.push({ relpath: '__repo_stats__.json', mtime: null, load: () => stats });
      return files;
    }
    case 'folder': {
      // Folder sources (e.g. University coursework) are large and mostly
      // low-value, so the default import takes only a deterministic structure
      // artifact — directory names and per-type counts, which is what
      // coursework claims actually cite. Documents are ingested only for an
      // explicitly requested subtree.
      const structure = scanFolderStructure(source.root_path, 3);
      const structureBytes = Buffer.from(JSON.stringify(structure, null, 2), 'utf8');
      const candidates: CandidateFile[] = [
        { relpath: '__folder_structure__.json', mtime: null, load: () => structureBytes },
      ];
      if (subpath) {
        const wanted = assertContained(source.root_path, join(source.root_path, subpath));
        collectFolderDocs(source.root_path, wanted, maxFileBytes, candidates, wanted);
      }
      return candidates;
    }
    // Manual sources are filled by ingestBytes from the intake screen. There
    // is no default branch: SourceKind is a closed union and the sources table
    // constrains kind to the same five, so a new kind has to be given a case
    // here rather than silently importing nothing.
    case 'manual':
      return [];
  }
}

interface FolderNode {
  name: string;
  files: number;
  by_extension: Record<string, number>;
  children: FolderNode[];
}

// Depth-limited directory census: names (the evidence — course titles) plus
// per-extension counts, never file contents.
function scanFolderStructure(dir: string, depth: number, name?: string): FolderNode {
  const node: FolderNode = { name: name ?? dir, files: 0, by_extension: {}, children: [] };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return node;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (FOLDER_SKIP_DIRS.has(entry.toLowerCase()) || entry.startsWith('.')) continue;
      const child = scanFolderStructure(full, depth - 1, entry);
      node.files += child.files;
      for (const [ext, n] of Object.entries(child.by_extension)) {
        node.by_extension[ext] = (node.by_extension[ext] ?? 0) + n;
      }
      if (depth > 0) node.children.push(child);
      continue;
    }
    node.files += 1;
    const ext = (
      entry.includes('.') ? entry.slice(entry.lastIndexOf('.')) : '(none)'
    ).toLowerCase();
    node.by_extension[ext] = (node.by_extension[ext] ?? 0) + 1;
  }
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  return node;
}

function collectFolderDocs(
  root: string,
  dir: string,
  maxFileBytes: number,
  out: CandidateFile[],
  onlyWithin: string | null,
): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      // Coursework/document folders often embed whole vendored project trees;
      // never descend into them.
      if (FOLDER_SKIP_DIRS.has(name.toLowerCase())) continue;
      collectFolderDocs(root, full, maxFileBytes, out, onlyWithin);
      continue;
    }
    if (!/\.(pdf|md|txt)$/i.test(name)) continue;
    if (st.size > maxFileBytes) continue;
    if (onlyWithin && !full.toLowerCase().startsWith(onlyWithin.toLowerCase())) continue;
    out.push({
      relpath: relative(root, full),
      mtime: st.mtime.toISOString(),
      load: () => readFileSync(full),
    });
  }
}

function assertUnderSizeCap(path: string, maxBytes: number): void {
  const st = statSync(path);
  if (st.size > maxBytes) {
    throw new DomainError('INVALID_INPUT', `file exceeds size cap (${st.size} bytes): ${path}`);
  }
}

function readBounded(path: string, maxBytes: number): Buffer {
  // Re-checked at read time, not only at collection time: the file can grow
  // between the two, and the loader is what actually pulls bytes into memory.
  assertUnderSizeCap(path, maxBytes);
  return readFileSync(path);
}

function mtimeOf(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

async function importOne(
  db: SqliteDriver,
  store: ArtifactStore,
  source: Source,
  runId: string,
  file: CandidateFile,
  dryRun: boolean,
): Promise<'imported' | 'duplicate'> {
  const bytes = file.load();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ACTIVE_SQL =
    'SELECT id, sha256 FROM artifacts WHERE source_id = ? AND source_relpath = ? AND superseded_by IS NULL';

  // Cheap pre-check outside the transaction so an unchanged file skips the
  // hashing and extraction work entirely. It is only an optimisation — the
  // authoritative check is repeated under the write lock below.
  const preActive = db.get(ACTIVE_SQL, source.id, file.relpath);
  if (preActive && String(preActive['sha256']) === sha256) return 'duplicate';
  if (dryRun) return 'imported';

  const put = store.put(bytes);
  const artifactId = newId('art');
  const extraction = await extractFromBytes(file.relpath, bytes, put.path);

  return withWriteTx(db, () => {
    // Re-read under the write lock. Extraction is async and can take seconds
    // (PDFs spawn a child process), so another process may have imported this
    // same path meanwhile — in which case the supersede target read earlier is
    // already stale and superseding it would fork the chain.
    const active = db.get(ACTIVE_SQL, source.id, file.relpath);
    if (active && String(active['sha256']) === sha256) return 'duplicate';

    // Supersede-then-insert, with FK checks deferred to commit: inserting the
    // replacement first would collide with the partial unique index on active
    // (source_id, source_relpath); updating first points superseded_by at a
    // row that doesn't exist yet. Deferral lets both constraints hold at
    // commit time. The old artifact is superseded, never deleted — review
    // history stays intact.
    db.exec('PRAGMA defer_foreign_keys = ON');
    if (active) {
      // Conditional on the row still being the active one. Without the
      // superseded_by IS NULL clause a concurrent import could supersede the
      // same predecessor twice, leaving two rows claiming the same path.
      const superseded = db.run(
        'UPDATE artifacts SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL',
        artifactId,
        String(active['id']),
      );
      if (Number(superseded.changes) !== 1) {
        throw new DomainError(
          'INVALID_INPUT',
          `artifact ${String(active['id'])} was superseded concurrently; re-run the import`,
          { blockers: ['concurrent_supersede'], retryable: true },
        );
      }
    }
    db.run(
      `INSERT INTO artifacts (id, source_id, source_relpath, sha256, size_bytes, mime, original_mtime, imported_at, import_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      artifactId,
      source.id,
      file.relpath,
      sha256,
      bytes.length,
      mimeFor(file.relpath),
      file.mtime,
      new Date().toISOString(),
      runId,
    );
    db.run(
      `INSERT INTO extractions (id, artifact_id, parser_name, parser_version, status, output_json, text, text_sha256, contains_secrets, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('ext'),
      artifactId,
      extraction.parser_name,
      extraction.parser_version,
      extraction.status,
      extraction.output_json,
      extraction.text,
      extraction.text_sha256,
      extraction.contains_secrets ? 1 : 0,
      extraction.error,
      new Date().toISOString(),
    );
    return 'imported';
  });
}
