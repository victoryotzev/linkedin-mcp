import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import { appendAuditEvent } from './auditService.ts';
import { listObservations } from './analyticsService.ts';

// Backups use SQLite's online backup API rather than a file copy: under WAL a
// raw copy taken mid-write can tear. Artifacts are copied alongside, and a
// manifest of hashes makes the archive self-verifying — an archive that does
// not verify is never accepted as a restore source.

export interface BackupManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format_version: 1;
  created_at: string;
  schema_version: number;
  entries: BackupManifestEntry[];
}

export interface BackupResult {
  name: string;
  directory: string;
  manifest_path: string;
  entries: number;
  total_bytes: number;
}

const SAFE_BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_BACKUP_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/;
const RESERVED_WINDOWS_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function validateBackupLabel(label: string): string {
  if (!SAFE_BACKUP_LABEL.test(label) || RESERVED_WINDOWS_NAME.test(label)) {
    throw new DomainError(
      'INVALID_INPUT',
      'backup label must be 1-40 characters, start and end with a letter or digit, and contain only letters, digits, dot, underscore, or hyphen',
      { blockers: ['unsafe_backup_label'] },
    );
  }
  return label;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const canonicalRoot = realpathSync.native(root);
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = lstatSync(full);
      // Artifacts are regular CAS files. Links and junctions are never valid
      // store entries, and following one could copy unrelated local files into
      // a backup while claiming everything came from the managed store.
      if (info.isSymbolicLink()) continue;
      const resolved = realpathSync.native(full);
      if (!isContained(canonicalRoot, resolved)) continue;
      if (info.isDirectory()) visit(resolved);
      else if (info.isFile()) out.push(resolved);
    }
  };
  visit(canonicalRoot);
  return out;
}

export async function runBackup(
  db: SqliteDriver,
  home: string,
  opts: { label?: string; actor?: 'mcp_host' | 'dashboard' } = {},
): Promise<BackupResult> {
  const label = opts.label === undefined ? undefined : validateBackupLabel(opts.label);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}${label ? `-${label}` : ''}`;
  const backupsRoot = join(home, 'backups');
  mkdirSync(backupsRoot, { recursive: true });
  const canonicalRoot = realpathSync.native(backupsRoot);
  const directory = resolve(canonicalRoot, name);
  // Unreachable today: `name` is a timestamp plus a label already run through
  // validateBackupLabel, so it cannot traverse. The check stays because it is
  // the thing that makes that true, rather than a comment asserting it.
  /* v8 ignore next 3 */
  if (!isContained(canonicalRoot, directory) || dirname(directory) !== canonicalRoot) {
    throw new DomainError('PATH_REJECTED', 'backup directory escaped the managed backup root');
  }
  mkdirSync(directory);

  const dbCopy = join(directory, 'linkedin.sqlite3');
  await db.backupTo(dbCopy);

  const entries: BackupManifestEntry[] = [
    { path: 'linkedin.sqlite3', bytes: statSync(dbCopy).size, sha256: hashFile(dbCopy) },
  ];

  const artifactsRoot = join(home, 'artifacts');
  // walk() returns canonical paths, so the root they are measured against has
  // to be canonical too. A home that is not its own canonical path is ordinary
  // on Windows — an 8.3 alias like PROGRA~1, a long account name, any folder
  // with a space in it, a junction — and measuring canonical files against the
  // uncanonical root made `relative` climb out of the tree and back down it.
  // Every artifact then took a '..' entry: copied to a directory beside the
  // backup rather than inside it, absent from the archive that claimed to hold
  // it, and refused by verifyBackup as an unsafe path. A backup that cannot
  // verify is also one that never unlocks the full purge.
  const canonicalArtifacts = existsSync(artifactsRoot)
    ? realpathSync.native(artifactsRoot)
    : artifactsRoot;
  for (const file of walk(artifactsRoot)) {
    const rel = join('artifacts', relative(canonicalArtifacts, file)).replaceAll('\\', '/');
    const dest = join(directory, rel);
    // Unreachable once the root above is canonical: walk only returns files it
    // has already proved are inside it, so `relative` cannot produce a '..'.
    // The check stays because it is the thing that makes that true, and because
    // the alternative to failing here is writing a member's evidence somewhere
    // nobody will look for it.
    /* v8 ignore next 5 */
    if (!isContained(directory, dest)) {
      throw new DomainError('PATH_REJECTED', 'artifact path escaped the backup directory', {
        blockers: ['unsafe_artifact_path'],
      });
    }
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(file, dest);
    entries.push({ path: rel, bytes: statSync(dest).size, sha256: hashFile(dest) });
  }

  const schemaVersion = Number(
    db.get('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')?.['v'] ?? 0,
  );
  const manifest: BackupManifest = {
    format_version: 1,
    created_at: new Date().toISOString(),
    schema_version: schemaVersion,
    entries,
  };
  const manifestPath = join(directory, 'backup-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Secrets are deliberately absent: DPAPI-wrapped material is machine-bound
  // and useless elsewhere, and excluding it makes every backup token-free.
  appendAuditEvent(db, {
    event_type: 'backup.created',
    actor: opts.actor ?? 'mcp_host',
    subject_type: 'backup',
    subject_id: directory,
    payload: { entries: entries.length, schema_version: schemaVersion },
  });

  return {
    name,
    directory,
    manifest_path: manifestPath,
    entries: entries.length,
    total_bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
  };
}

export interface BackupListing {
  name: string;
  created_at: string;
  entries: number;
  total_bytes: number;
}

// Backups by NAME, never by path.
//
// Verification is reachable from the dashboard, and a route that accepted a
// caller-supplied directory would be a filesystem path arriving at the one
// authenticated local surface. Callers pass a name; it is resolved by lookup
// against this listing, so nothing outside <home>/backups is addressable.
export function listBackups(home: string): BackupListing[] {
  const root = join(home, 'backups');
  if (!existsSync(root)) return [];
  const canonicalRoot = realpathSync.native(root);
  const listings: BackupListing[] = [];
  for (const name of readdirSync(root)) {
    const directory = join(canonicalRoot, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(directory);
    } catch {
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const resolved = realpathSync.native(directory);
    if (!isContained(canonicalRoot, resolved) || dirname(resolved) !== canonicalRoot) continue;
    const manifestPath = join(resolved, 'backup-manifest.json');
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
      listings.push({
        name,
        created_at: manifest.created_at,
        entries: manifest.entries.length,
        total_bytes: manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    } catch {
      // An unreadable manifest is not a backup. It is listed as unusable rather
      // than silently skipped, so it cannot be mistaken for a safety net.
      listings.push({ name, created_at: '', entries: 0, total_bytes: 0 });
    }
  }
  return listings.sort((a, b) => b.name.localeCompare(a.name));
}

/** Resolves a backup name to its directory, or null if it is not a real backup. */
export function resolveBackupDir(home: string, name: string): string | null {
  if (!SAFE_BACKUP_NAME.test(name) || name === '.' || name === '..') return null;
  const root = join(home, 'backups');
  if (!existsSync(root)) return null;
  const canonicalRoot = realpathSync.native(root);
  const directory = resolve(canonicalRoot, name);
  if (!isContained(canonicalRoot, directory) || dirname(directory) !== canonicalRoot) return null;
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const resolved = realpathSync.native(directory);
    if (!isContained(canonicalRoot, resolved) || dirname(resolved) !== canonicalRoot) return null;
    const manifestPath = join(resolved, 'backup-manifest.json');
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) return null;
    return resolved;
  } catch {
    return null;
  }
}

export interface VerifyResult {
  valid: boolean;
  checked: number;
  problems: string[];
}

// Ported from the Seller project's backup verifier: refuse absolute paths,
// traversal, duplicates and hash mismatches. A backup is only a backup once it
// has been verified.
export function verifyBackup(directory: string): VerifyResult {
  const problems: string[] = [];
  let canonicalDirectory: string;
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return {
        valid: false,
        checked: 0,
        problems: ['backup directory must be a real directory, not a link'],
      };
    }
    canonicalDirectory = realpathSync.native(directory);
  } catch {
    return { valid: false, checked: 0, problems: ['backup directory is missing or unreadable'] };
  }
  const manifestPath = join(canonicalDirectory, 'backup-manifest.json');
  if (!existsSync(manifestPath)) {
    return { valid: false, checked: 0, problems: ['backup-manifest.json is missing'] };
  }
  if (lstatSync(manifestPath).isSymbolicLink()) {
    return { valid: false, checked: 0, problems: ['backup-manifest.json must not be a link'] };
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch (err) {
    return { valid: false, checked: 0, problems: [`manifest is unreadable: ${String(err)}`] };
  }
  if (!manifest || typeof manifest !== 'object' || manifest.format_version !== 1) {
    problems.push(`unsupported format_version ${String(manifest?.format_version)}`);
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    return {
      valid: false,
      checked: 0,
      problems: [...problems, 'manifest entries must be a non-empty array'],
    };
  }

  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_HEX.test(entry.sha256)
    ) {
      problems.push('malformed manifest entry');
      continue;
    }
    const normalized = posix.normalize(entry.path);
    const segments = entry.path.split('/');
    if (
      entry.path.length === 0 ||
      entry.path.includes('\\') ||
      posix.isAbsolute(entry.path) ||
      normalized !== entry.path ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      /^[A-Za-z]:/.test(entry.path)
    ) {
      problems.push(`unsafe path in manifest: ${entry.path}`);
      continue;
    }
    if (segments[0]?.toLowerCase() === 'secrets') {
      problems.push(`backup contains secret material: ${entry.path}`);
      continue;
    }
    if (seen.has(entry.path)) {
      problems.push(`duplicate manifest entry: ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
    const full = resolve(canonicalDirectory, ...segments);
    // Unreachable today: the shape check above already refuses absolute paths,
    // drive letters, backslashes and every '..' segment, so resolve cannot
    // leave the directory. This is the second of two locks on one door, and
    // the first is a string comparison.
    /* v8 ignore next 4 */
    if (!isContained(canonicalDirectory, full)) {
      problems.push(`unsafe path in manifest: ${entry.path}`);
      continue;
    }
    if (!existsSync(full)) {
      problems.push(`missing file: ${entry.path}`);
      continue;
    }
    const info = lstatSync(full);
    if (!info.isFile() || info.isSymbolicLink()) {
      problems.push(`entry is not a regular file: ${entry.path}`);
      continue;
    }
    const resolved = realpathSync.native(full);
    if (!isContained(canonicalDirectory, resolved)) {
      problems.push(`entry escapes backup directory: ${entry.path}`);
      continue;
    }
    if (info.size !== entry.bytes) problems.push(`size mismatch: ${entry.path}`);
    if (hashFile(full) !== entry.sha256) problems.push(`hash mismatch: ${entry.path}`);
  }

  if (!seen.has('linkedin.sqlite3')) {
    problems.push('manifest must contain linkedin.sqlite3');
  }

  return { valid: problems.length === 0, checked: manifest.entries.length, problems };
}

export function verifyManagedBackup(home: string, name: string): VerifyResult {
  const directory = resolveBackupDir(home, name);
  if (!directory) {
    throw new DomainError('NOT_FOUND', `managed backup '${name}' was not found`, {
      blockers: ['backup_not_managed'],
    });
  }
  return verifyBackup(directory);
}

export interface ExportBundle {
  claims: unknown[];
  canonical_sections: unknown[];
  drafts: unknown[];
  observations: unknown[];
  note: string;
}

// Exports carry only the member's own data. Marketing/CM-sourced rows may not
// leave the application under LinkedIn's restricted-use terms, so they are
// filtered by retention class rather than by hand.
export function exportBundle(db: SqliteDriver): ExportBundle {
  return {
    claims: db.all(
      "SELECT id, statement, state, method, limitations, sensitivity, created_at FROM claims WHERE state != 'rejected'",
    ),
    canonical_sections: db.all(
      `SELECT cs.section_key, cr.content_text, cr.claim_ids_json, cr.created_at
       FROM canonical_sections cs LEFT JOIN canonical_revisions cr ON cr.id = cs.current_revision_id`,
    ),
    drafts: db.all(
      `SELECT d.id, d.slug, d.state, r.body_text FROM post_drafts d
       JOIN draft_revisions r ON r.draft_id = d.id AND r.revision = d.current_revision`,
    ),
    observations: listObservations(db, { limit: 10_000 }).filter(
      (o) => o.retention_class !== 'marketing_48h',
    ),
    note: "Own data only: Marketing/Community-Management-sourced rows are excluded because LinkedIn's restricted-use terms forbid exporting them from the application.",
  };
}

export interface PurgeAllResult {
  removed: string[];
  kept: string[];
}

// Full local purge. Deleting the DPAPI-wrapped master key (when one exists)
// is what makes this a crypto-erase: any stray ciphertext elsewhere becomes
// permanently undecryptable.
export function purgeEverything(home: string, confirmPhrase: string): PurgeAllResult {
  if (confirmPhrase !== 'DELETE ALL LOCAL DATA') {
    throw new DomainError(
      'INVALID_INPUT',
      'full purge requires confirm_phrase to be exactly "DELETE ALL LOCAL DATA"',
    );
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const dir of ['data', 'artifacts', 'backups', 'logs', 'secrets']) {
    const full = join(home, dir);
    if (existsSync(full)) {
      rmSync(full, { recursive: true, force: true, maxRetries: 3 });
      removed.push(dir);
    } else {
      kept.push(dir);
    }
  }
  return { removed, kept };
}
