import type { ArtifactStore, SqliteDriver } from '@linkedin-mcp/db';
import { withWriteTx } from '@linkedin-mcp/db';
import { parseCsv } from '@linkedin-mcp/importers';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { getSource } from './sourceService.ts';
import { verifyAppliedPatches } from './changesetService.ts';

// Versioned imported LinkedIn profile states, normalized into snapshot_fields
// for diffing. v1 parses the Basic export CSVs; the profile PDF lands as one
// raw-text field (lossy source, deprioritized by design); the DMA lane (P14)
// reuses the same field keys.

export interface Snapshot {
  id: string;
  source_kind: 'export_csv' | 'profile_pdf' | 'dma_snapshot';
  source_id: string;
  taken_at: string | null;
  imported_at: string;
  version: number;
  fields: Record<string, { value_text: string; char_count: number }>;
  warnings: string[];
}

function csvRows(db: SqliteDriver, store: ArtifactStore, sourceId: string, relpath: string) {
  const art = db.get(
    'SELECT sha256 FROM artifacts WHERE source_id = ? AND source_relpath = ? AND superseded_by IS NULL',
    sourceId,
    relpath,
  );
  if (!art) return null;
  return parseCsv(Buffer.from(store.read(String(art['sha256']))).toString());
}

function tableToObjects(rows: string[][]): Array<Record<string, string>> {
  const header = rows[0] ?? [];
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((name, i) => {
      obj[name] = row[i] ?? '';
    });
    return obj;
  });
}

/** `' — Google'` when there is an issuer, and nothing at all when there is not. */
const part = (prefix: string, value: string | undefined, suffix = ''): string =>
  value ? `${prefix}${value}${suffix}` : '';

/**
 * The export tables with no bespoke handling above.
 *
 * Positions, education, skills and certifications are written out longhand
 * because each shapes its text differently enough to be worth reading directly.
 * These five follow one pattern: filter on the column that must be present,
 * render a line, and drop the table if it yields nothing. Field keys and the
 * rendered shape match the matching renderer in dmaProfileDomains.ts, so the
 * same course reads identically whichever lane imported it.
 */
const EXPORT_TABLES: ReadonlyArray<{
  file: string;
  key: string;
  required: string;
  render: (row: Record<string, string>) => string;
}> = [
  {
    file: 'Courses.csv',
    key: 'courses',
    required: 'Name',
    render: (r) => `${r['Name']}${part(' · ', r['Number'])}`,
  },
  {
    file: 'Honors.csv',
    key: 'honors',
    required: 'Title',
    render: (r) =>
      `${r['Title']}${part(' — ', r['Issuer'])}${part(' (', r['Issued On'], ')')}` +
      part(': ', r['Description']),
  },
  {
    file: 'Languages.csv',
    key: 'languages',
    required: 'Name',
    render: (r) => `${r['Name']}${part(' — ', r['Proficiency'])}`,
  },
  {
    file: 'Projects.csv',
    key: 'projects',
    required: 'Title',
    render: (r) =>
      `${r['Title']} (${r['Started On'] || '?'} – ${r['Finished On'] || 'present'})` +
      part(' · ', r['Url']) +
      part(': ', r['Description']),
  },
  {
    file: 'Publications.csv',
    key: 'publications',
    required: 'Name',
    render: (r) =>
      `${r['Name']}${part(' — ', r['Publisher'])}${part(' (', r['Published On'], ')')}` +
      part(' · ', r['Url']) +
      part(': ', r['Description']),
  },
];

export function importSnapshot(
  db: SqliteDriver,
  store: ArtifactStore,
  sourceId: string,
  takenAt?: string,
): Snapshot {
  const source = getSource(db, sourceId);
  const warnings: string[] = [];
  const fields: Array<{ key: string; text: string; raw: unknown }> = [];

  if (source.kind === 'linkedin_export') {
    const profile = csvRows(db, store, sourceId, 'Profile.csv');
    if (profile && profile.length > 1) {
      const row = tableToObjects(profile)[0]!;
      for (const [csvName, fieldKey] of [
        ['Headline', 'headline'],
        ['Summary', 'about'],
        ['Industry', 'industry'],
        ['Geo Location', 'geo_location'],
        ['Websites', 'websites'],
        ['First Name', 'first_name'],
        ['Last Name', 'last_name'],
      ] as const) {
        const value = row[csvName] ?? '';
        if (value) fields.push({ key: fieldKey, text: value, raw: null });
      }
    } else {
      warnings.push('Profile.csv missing or empty');
    }

    const positions = csvRows(db, store, sourceId, 'Positions.csv');
    if (positions) {
      const objs = tableToObjects(positions).filter((p) => p['Company Name'] || p['Title']);
      fields.push({
        key: 'experience',
        text: objs
          .map(
            (p) =>
              `${p['Title']} — ${p['Company Name']} (${p['Started On'] || '?'} – ${p['Finished On'] || 'present'})${p['Description'] ? `: ${p['Description']}` : ''}`,
          )
          .join('\n'),
        raw: objs,
      });
    }

    const education = csvRows(db, store, sourceId, 'Education.csv');
    if (education) {
      const objs = tableToObjects(education).filter((e) => e['School Name']);
      fields.push({
        key: 'education',
        text: objs
          .map(
            (e) =>
              `${e['School Name']}${e['Degree Name'] ? ` — ${e['Degree Name']}` : ''} (${e['Start Date'] || '?'} – ${e['End Date'] || 'present'})`,
          )
          .join('\n'),
        raw: objs,
      });
    }

    const skills = csvRows(db, store, sourceId, 'Skills.csv');
    if (skills) {
      const names = skills
        .slice(1)
        .map((r) => r[0])
        .filter((n): n is string => Boolean(n));
      fields.push({ key: 'skills', text: names.join(', '), raw: names });
    }

    // Certifications.csv was simply not read. `certifications` has been a
    // canonical section since migration 005 and the DMA lane has always mapped
    // the domain, so an export import produced a profile with a certifications
    // section that could only ever be empty — and nothing anywhere said why.
    // The rendered shape matches CERTIFICATIONS in dmaProfileDomains.ts, so the
    // same certificate reads identically whichever lane imported it.
    const certifications = csvRows(db, store, sourceId, 'Certifications.csv');
    if (certifications) {
      const objs = tableToObjects(certifications).filter((c) => c['Name']);
      fields.push({
        key: 'certifications',
        text: objs
          .map((c) => {
            const authority = c['Authority'] ? ` — ${c['Authority']}` : '';
            const range = `${c['Started On'] || '?'} – ${c['Finished On'] || 'present'}`;
            const license = c['License Number'] ? ` · #${c['License Number']}` : '';
            return `${c['Name']}${authority} (${range})${license}`;
          })
          .join('\n'),
        raw: objs,
      });
    }

    // The DMA lane reads ten profile domains; this lane read four. Everything
    // below existed in the export ZIP all along and was simply never opened, so
    // which lane a member imported through silently decided how much of their
    // profile this product could see. Each renders in the same shape as its
    // counterpart in dmaProfileDomains.ts.
    for (const table of EXPORT_TABLES) {
      const rows = csvRows(db, store, sourceId, table.file);
      if (!rows) continue;
      const objs = tableToObjects(rows).filter((row) => row[table.required]);
      if (objs.length === 0) continue;
      fields.push({
        key: table.key,
        text: objs.map(table.render).join('\n'),
        raw: objs,
      });
    }
  } else if (source.kind === 'document') {
    const ext = db.get(
      `SELECT e.text FROM extractions e JOIN artifacts a ON a.id = e.artifact_id
       WHERE a.source_id = ? AND a.superseded_by IS NULL AND e.status = 'ok'
       ORDER BY e.rowid DESC`,
      sourceId,
    );
    if (!ext?.['text']) {
      throw new DomainError(
        'INVALID_INPUT',
        'no extracted text available for a profile_pdf snapshot',
      );
    }
    warnings.push(
      'profile_pdf snapshots are raw text only (lossy source); prefer the export or DMA',
    );
    fields.push({ key: 'raw_profile_text', text: String(ext['text']), raw: null });
  } else {
    throw new DomainError(
      'INVALID_INPUT',
      `snapshots import from linkedin_export or document (profile PDF) sources; got kind '${source.kind}'`,
    );
  }

  if (fields.length === 0) {
    throw new DomainError('INVALID_INPUT', 'no snapshot fields could be parsed from this source');
  }

  return withWriteTx(db, () => {
    const version =
      Number(db.get('SELECT COALESCE(MAX(version), 0) AS v FROM linkedin_snapshots')?.['v'] ?? 0) +
      1;
    const snapshot: Snapshot = {
      id: newId('snp'),
      source_kind: source.kind === 'linkedin_export' ? 'export_csv' : 'profile_pdf',
      source_id: sourceId,
      taken_at: takenAt ?? null,
      imported_at: new Date().toISOString(),
      version,
      fields: {},
      warnings,
    };
    db.run(
      `INSERT INTO linkedin_snapshots (id, source_kind, source_id, taken_at, imported_at, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
      snapshot.id,
      snapshot.source_kind,
      snapshot.source_id,
      snapshot.taken_at,
      snapshot.imported_at,
      version,
    );
    for (const field of fields) {
      db.run(
        `INSERT INTO snapshot_fields (snapshot_id, field_key, value_text, char_count, raw_json)
         VALUES (?, ?, ?, ?, ?)`,
        snapshot.id,
        field.key,
        field.text,
        field.text.length,
        field.raw === null ? null : JSON.stringify(field.raw),
      );
      snapshot.fields[field.key] = { value_text: field.text, char_count: field.text.length };
    }
    // Close the manual copy/paste loop: applied patches whose exact text now
    // shows up in this snapshot get their verification pointer set.
    const verified = verifyAppliedPatches(db, snapshot);
    if (verified > 0)
      snapshot.warnings.push(`${verified} applied patch(es) auto-verified by this snapshot`);
    return snapshot;
  });
}

export function getSnapshot(db: SqliteDriver, id: string): Snapshot {
  const row = db.get('SELECT * FROM linkedin_snapshots WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `snapshot ${id} not found`);
  const fields: Snapshot['fields'] = {};
  for (const f of db.all('SELECT * FROM snapshot_fields WHERE snapshot_id = ?', id)) {
    fields[String(f['field_key'])] = {
      value_text: String(f['value_text']),
      char_count: Number(f['char_count']),
    };
  }
  return {
    id: String(row['id']),
    source_kind: String(row['source_kind']) as Snapshot['source_kind'],
    source_id: String(row['source_id']),
    taken_at: (row['taken_at'] as string | null) ?? null,
    imported_at: String(row['imported_at']),
    version: Number(row['version']),
    fields,
    warnings: [],
  };
}

export function listSnapshots(db: SqliteDriver): Array<Omit<Snapshot, 'fields' | 'warnings'>> {
  return db.all('SELECT * FROM linkedin_snapshots ORDER BY version DESC').map((row) => ({
    id: String(row['id']),
    source_kind: String(row['source_kind']) as Snapshot['source_kind'],
    source_id: String(row['source_id']),
    taken_at: (row['taken_at'] as string | null) ?? null,
    imported_at: String(row['imported_at']),
    version: Number(row['version']),
  }));
}

export function latestSnapshot(db: SqliteDriver): Snapshot | null {
  const row = db.get('SELECT id FROM linkedin_snapshots ORDER BY version DESC');
  return row ? getSnapshot(db, String(row['id'])) : null;
}
