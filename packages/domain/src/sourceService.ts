import { statSync } from 'node:fs';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { canonicalizePath, isContainedIn } from '@linkedin-mcp/importers';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { appendAuditEvent, type AuditActor } from './auditService.ts';

export const SOURCE_KINDS = ['repo', 'document', 'folder', 'linkedin_export', 'manual'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// `self_attested` is what the member typed about themselves during onboarding:
// an assertion with no document behind it. It ranks below personal_doc, and is
// listed last so ordering reads as descending strength.
export const SOURCE_TRUSTS = [
  'own_repo',
  'personal_doc',
  'local_clone_reference',
  'self_attested',
] as const;
export type SourceTrust = (typeof SOURCE_TRUSTS)[number];

// The database stores three trust values and a flag, because widening the
// CHECK constraint would have meant rebuilding a table that parents three
// foreign keys (see migration 019). That split stops here: every caller above
// this module sees one four-value enum.
const STORED_TRUSTS = ['personal_doc', 'own_repo', 'local_clone_reference'] as const;
type StoredTrust = (typeof STORED_TRUSTS)[number];

function toStorage(trust: SourceTrust): { trust: StoredTrust; self_attested: 0 | 1 } {
  return trust === 'self_attested'
    ? { trust: 'personal_doc', self_attested: 1 }
    : { trust, self_attested: 0 };
}

export type SourceStatus = 'pending_review' | 'enabled' | 'disabled' | 'archived';

export interface Source {
  id: string;
  kind: SourceKind;
  root_path: string;
  label: string;
  trust: SourceTrust;
  status: SourceStatus;
  registered_at: string;
  enabled_at: string | null;
  last_import_at: string | null;
  notes: string | null;
}

function rowToSource(row: Record<string, unknown>): Source {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as SourceKind,
    root_path: String(row['root_path']),
    label: String(row['label']),
    trust:
      Number(row['self_attested'] ?? 0) === 1
        ? 'self_attested'
        : (String(row['trust']) as SourceTrust),
    status: String(row['status']) as SourceStatus,
    registered_at: String(row['registered_at']),
    enabled_at: (row['enabled_at'] as string | null) ?? null,
    last_import_at: (row['last_import_at'] as string | null) ?? null,
    notes: (row['notes'] as string | null) ?? null,
  };
}

export interface RegisterSourceInput {
  path: string;
  kind: SourceKind;
  trust: SourceTrust;
  label: string;
  notes?: string;
  // The data home: registering anything inside the app's own storage is
  // refused (an importer must never ingest its own store or database).
  dataHome: string;
}

// Registration lands in 'pending_review'. Enabling is a separate transition
// requiring an explicit source-id-bound confirmation on every surface.
export function registerSource(db: SqliteDriver, input: RegisterSourceInput): Source {
  const canonical = canonicalizePath(input.path);
  const home = canonicalizePathSafe(input.dataHome);
  if (home && (isContainedIn(home, canonical) || isContainedIn(canonical, home))) {
    throw new DomainError(
      'PATH_REJECTED',
      'source root overlaps the linkedin-mcp data directory; refusing to ingest own storage',
    );
  }
  const st = statSync(canonical);
  if (input.kind === 'document' || input.kind === 'linkedin_export') {
    if (!st.isFile()) {
      throw new DomainError('INVALID_INPUT', `kind '${input.kind}' expects a file path`);
    }
  } else if (!st.isDirectory()) {
    throw new DomainError('INVALID_INPUT', `kind '${input.kind}' expects a directory path`);
  }

  const existing = db.get('SELECT id FROM sources WHERE root_path = ?', canonical);
  if (existing) {
    throw new DomainError('INVALID_INPUT', `source already registered for ${canonical}`);
  }

  const source: Source = {
    id: newId('src'),
    kind: input.kind,
    root_path: canonical,
    label: input.label,
    trust: input.trust,
    status: 'pending_review',
    registered_at: new Date().toISOString(),
    enabled_at: null,
    last_import_at: null,
    notes: input.notes ?? null,
  };
  insertSource(db, source);
  return source;
}

function insertSource(db: SqliteDriver, source: Source): void {
  const stored = toStorage(source.trust);
  withWriteTx(db, () => {
    db.run(
      `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at, notes, self_attested)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source.id,
      source.kind,
      source.root_path,
      source.label,
      stored.trust,
      source.status,
      source.registered_at,
      source.notes,
      stored.self_attested,
    );
  });
}

export interface RegisterVirtualSourceInput {
  /** Distinguishes an upload from typed self-description. */
  origin: 'upload' | 'self_description';
  label: string;
  trust: SourceTrust;
  notes?: string;
}

/**
 * A source with no filesystem root: bytes arrive from an upload or a text box
 * rather than from a directory scan.
 *
 * `root_path` is NOT NULL UNIQUE, so it carries a namespaced sentinel keyed on
 * the source id — the shape `dmaObservationService` already uses for
 * `linkedin://dma`. The path guard is not consulted, because there is no path
 * to guard: nothing here ever reaches the filesystem. That is a narrower
 * surface than a real source, not a wider one.
 *
 * Registration still lands in `pending_review`. Uploading a file is not the
 * same act as deciding to trust it, and the ENABLE confirmation is unchanged.
 */
export function registerVirtualSource(db: SqliteDriver, input: RegisterVirtualSourceInput): Source {
  if (input.label.trim() === '') {
    throw new DomainError('INVALID_INPUT', 'a virtual source needs a label');
  }
  const id = newId('src');
  const scheme = input.origin === 'upload' ? 'upload' : 'manual';
  const source: Source = {
    id,
    kind: 'manual',
    root_path: `${scheme}://${id}`,
    label: input.label.trim(),
    trust: input.trust,
    status: 'pending_review',
    registered_at: new Date().toISOString(),
    enabled_at: null,
    last_import_at: null,
    notes: input.notes ?? null,
  };
  insertSource(db, source);
  return source;
}

/** True for a source whose bytes never came from a directory on disk. */
export function isVirtualSource(source: Source): boolean {
  return source.root_path.startsWith('upload://') || source.root_path.startsWith('manual://');
}

function canonicalizePathSafe(path: string): string | null {
  try {
    return canonicalizePath(path);
  } catch {
    return null; // data home not created yet -> nothing to overlap with
  }
}

export function listSources(
  db: SqliteDriver,
  filters: { status?: string; kind?: string } = {},
): Source[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.kind) {
    clauses.push('kind = ?');
    params.push(filters.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .all(`SELECT * FROM sources ${where} ORDER BY registered_at`, ...params)
    .map(rowToSource);
}

export function getSource(db: SqliteDriver, id: string): Source {
  const row = db.get('SELECT * FROM sources WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `source ${id} not found`);
  return rowToSource(row);
}

// Restrictive transitions are always safe to expose through either surface.
export function restrictSource(
  db: SqliteDriver,
  id: string,
  action: 'disable' | 'archive',
): Source {
  const source = getSource(db, id);
  const next: SourceStatus = action === 'disable' ? 'disabled' : 'archived';
  withWriteTx(db, () => {
    db.run('UPDATE sources SET status = ? WHERE id = ?', next, id);
  });
  return { ...source, status: next };
}

// Called by explicitly confirmed human decisions from MCP, the dashboard, or
// the local terminal control CLI.
export function enableSourceFromDashboard(
  db: SqliteDriver,
  id: string,
  actor: AuditActor = 'dashboard',
): Source {
  const source = getSource(db, id);
  if (source.status === 'archived') {
    throw new DomainError('TERMINAL_STATE', 'archived sources cannot be re-enabled');
  }
  const enabledAt = new Date().toISOString();
  withWriteTx(db, () => {
    db.run("UPDATE sources SET status = 'enabled', enabled_at = ? WHERE id = ?", enabledAt, id);
    appendAuditEvent(db, {
      event_type: 'source.enabled',
      actor,
      subject_type: 'source',
      subject_id: id,
      payload: { root_path: source.root_path, trust: source.trust },
    });
  });
  return { ...source, status: 'enabled', enabled_at: enabledAt };
}
