import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId, type Jsonish } from '@linkedin-mcp/shared';
import { getSnapshot, latestSnapshot, type Snapshot } from './snapshotService.ts';

export const CANONICAL_SECTIONS = [
  'headline',
  'about',
  'experience',
  'education',
  'skills',
  'certifications',
  'audiences',
  'positioning_brief',
  'keyword_map',
] as const;
export type SectionKey = (typeof CANONICAL_SECTIONS)[number];

export interface CanonicalRevision {
  id: string;
  section_key: SectionKey;
  content_text: string;
  content_hash: string;
  based_on_revision: string | null;
  claim_ids: string[];
  rationale: string | null;
  author: 'user' | 'mcp_host';
  created_at: string;
}

export function seedCanonicalSections(db: SqliteDriver): void {
  withWriteTx(db, () => {
    for (const key of CANONICAL_SECTIONS) {
      db.run('INSERT INTO canonical_sections (section_key) VALUES (?) ON CONFLICT DO NOTHING', key);
    }
  });
}

function revisionOf(db: SqliteDriver, id: string): CanonicalRevision {
  const row = db.get('SELECT * FROM canonical_revisions WHERE id = ?', id);
  if (!row) throw new DomainError('NOT_FOUND', `revision ${id} not found`);
  return {
    id: String(row['id']),
    section_key: String(row['section_key']) as SectionKey,
    content_text: String(row['content_text']),
    content_hash: String(row['content_hash']),
    based_on_revision: (row['based_on_revision'] as string | null) ?? null,
    claim_ids: JSON.parse(String(row['claim_ids_json'])) as string[],
    rationale: (row['rationale'] as string | null) ?? null,
    author: String(row['author']) as 'user' | 'mcp_host',
    created_at: String(row['created_at']),
  };
}

export function getProfile(
  db: SqliteDriver,
  sections?: SectionKey[],
): Partial<Record<SectionKey, CanonicalRevision | null>> {
  const wanted = sections ?? [...CANONICAL_SECTIONS];
  const out: Partial<Record<SectionKey, CanonicalRevision | null>> = {};
  for (const key of wanted) {
    const row = db.get(
      'SELECT current_revision_id FROM canonical_sections WHERE section_key = ?',
      key,
    );
    const revId = row?.['current_revision_id'] as string | null | undefined;
    out[key] = revId ? revisionOf(db, revId) : null;
  }
  return out;
}

// Append-only revisions: 'current' is a pointer, never an overwrite. Every
// cited claim must be VERIFIED at write time; optimistic concurrency via
// based_on_revision keeps MCP host and dashboard from clobbering each other.
export function updateSection(
  db: SqliteDriver,
  input: {
    section_key: SectionKey;
    content_text: string;
    content_json?: Jsonish;
    claim_ids: string[];
    rationale?: string;
    author: 'user' | 'mcp_host';
    based_on_revision: string | null;
  },
): CanonicalRevision {
  return withWriteTx(db, () => {
    const section = db.get(
      'SELECT current_revision_id FROM canonical_sections WHERE section_key = ?',
      input.section_key,
    );
    if (!section) throw new DomainError('NOT_FOUND', `unknown section ${input.section_key}`);
    const current = (section['current_revision_id'] as string | null) ?? null;
    if (current !== input.based_on_revision) {
      throw new DomainError(
        'REVISION_CONFLICT',
        `section ${input.section_key} moved: current revision is ${current ?? 'none'}, you based on ${input.based_on_revision ?? 'none'}; re-read and retry`,
      );
    }

    const offenders: string[] = [];
    for (const claimId of input.claim_ids) {
      const claim = db.get('SELECT state FROM claims WHERE id = ?', claimId);
      if (!claim || String(claim['state']) !== 'verified') {
        offenders.push(`${claimId} (${claim ? String(claim['state']) : 'missing'})`);
      }
    }
    if (offenders.length > 0) {
      throw new DomainError(
        'EVIDENCE_NOT_VERIFIED',
        `canonical content may cite only verified claims; offending: ${offenders.join(', ')}`,
      );
    }

    const revision: CanonicalRevision = {
      id: newId('rev'),
      section_key: input.section_key,
      content_text: input.content_text,
      content_hash: createHash('sha256').update(input.content_text, 'utf8').digest('hex'),
      based_on_revision: input.based_on_revision,
      claim_ids: input.claim_ids,
      rationale: input.rationale ?? null,
      author: input.author,
      created_at: new Date().toISOString(),
    };
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.run(
      `INSERT INTO canonical_revisions (id, section_key, content_text, content_json, content_hash, based_on_revision, claim_ids_json, rationale, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revision.id,
      revision.section_key,
      revision.content_text,
      input.content_json === undefined ? null : JSON.stringify(input.content_json),
      revision.content_hash,
      revision.based_on_revision,
      JSON.stringify(revision.claim_ids),
      revision.rationale,
      revision.author,
      revision.created_at,
    );
    db.run(
      'UPDATE canonical_sections SET current_revision_id = ? WHERE section_key = ?',
      revision.id,
      input.section_key,
    );
    return revision;
  });
}

// ---- Diff --------------------------------------------------------------

// Snapshot field keys <-> canonical section keys. Keys with no entry here fall
// through unchanged, so the DMA lane's newer sections (courses, honors,
// languages, projects, publications) diff against themselves rather than
// silently colliding with a canonical section they are not.
const FIELD_TO_SECTION: Record<string, SectionKey> = {
  headline: 'headline',
  about: 'about',
  experience: 'experience',
  education: 'education',
  skills: 'skills',
  certifications: 'certifications',
};

export interface FieldDiff {
  field_key: string;
  left_text: string | null;
  right_text: string | null;
  left_chars: number;
  right_chars: number;
  changed: boolean;
}

export type DiffRef = 'canonical' | `snapshot:${string}` | 'snapshot:latest';

function resolveRef(db: SqliteDriver, ref: DiffRef): Record<string, string> {
  if (ref === 'canonical') {
    const profile = getProfile(db);
    const out: Record<string, string> = {};
    for (const [key, rev] of Object.entries(profile)) {
      if (rev) out[key] = rev.content_text;
    }
    return out;
  }
  const id = ref.slice('snapshot:'.length);
  const snapshot: Snapshot | null = id === 'latest' ? latestSnapshot(db) : getSnapshot(db, id);
  if (!snapshot) throw new DomainError('NOT_FOUND', 'no snapshot available yet — import one first');
  const out: Record<string, string> = {};
  for (const [fieldKey, field] of Object.entries(snapshot.fields)) {
    out[FIELD_TO_SECTION[fieldKey] ?? fieldKey] = field.value_text;
  }
  return out;
}

export function diffProfile(db: SqliteDriver, left: DiffRef, right: DiffRef): FieldDiff[] {
  const l = resolveRef(db, left);
  const r = resolveRef(db, right);
  const keys = [...new Set([...Object.keys(l), ...Object.keys(r)])].sort();
  return keys.map((key) => {
    const lt = l[key] ?? null;
    const rt = r[key] ?? null;
    return {
      field_key: key,
      left_text: lt,
      right_text: rt,
      left_chars: lt?.length ?? 0,
      right_chars: rt?.length ?? 0,
      changed: lt !== rt,
    };
  });
}

// ---- Score -------------------------------------------------------------

export interface ScoreFinding {
  dimension: 'completeness' | 'evidence_coverage' | 'freshness';
  score: number; // transparent ratio 0..1, never fake precision
  explanation: string;
  details: string[];
}

const CORE_SECTIONS: SectionKey[] = ['headline', 'about', 'experience', 'education', 'skills'];

export function scoreProfile(db: SqliteDriver): ScoreFinding[] {
  const profile = getProfile(db);
  const findings: ScoreFinding[] = [];

  const present = CORE_SECTIONS.filter((key) => (profile[key]?.content_text ?? '').length > 0);
  findings.push({
    dimension: 'completeness',
    score: Number((present.length / CORE_SECTIONS.length).toFixed(2)),
    explanation: `${present.length} of ${CORE_SECTIONS.length} core canonical sections have content`,
    details: CORE_SECTIONS.map((key) => `${key}: ${present.includes(key) ? 'present' : 'EMPTY'}`),
  });

  const cited = new Set<string>();
  // A Set, not a counter. One claim cited by three sections was counted three
  // times against a denominator of DISTINCT claims, so freshness could go
  // negative. A claim whose row is missing entirely also counts as stale — it
  // certainly is not verified.
  const staleClaims = new Set<string>();
  const details: string[] = [];
  for (const key of CORE_SECTIONS) {
    const rev = profile[key];
    if (!rev) continue;
    if (rev.claim_ids.length === 0) details.push(`${key}: cites no claims`);
    for (const id of rev.claim_ids) {
      cited.add(id);
      const claim = db.get('SELECT state FROM claims WHERE id = ?', id);
      if (!claim || String(claim['state']) !== 'verified') {
        staleClaims.add(id);
        details.push(
          `${key}: cites ${id} which is now ${claim ? String(claim['state']) : 'missing'}`,
        );
      }
    }
  }
  const staleCited = staleClaims.size;
  const populated = CORE_SECTIONS.filter((k) => profile[k]);
  const withCitations = populated.filter((k) => (profile[k]?.claim_ids.length ?? 0) > 0);
  findings.push({
    dimension: 'evidence_coverage',
    score:
      populated.length === 0 ? 0 : Number((withCitations.length / populated.length).toFixed(2)),
    explanation: `${withCitations.length} of ${populated.length} populated core sections cite claims (${cited.size} distinct claims cited)`,
    details,
  });

  findings.push({
    dimension: 'freshness',
    score: cited.size === 0 ? 0 : Number(((cited.size - staleCited) / cited.size).toFixed(2)),
    explanation:
      staleCited === 0
        ? 'no cited claim has expired or been demoted'
        : `${staleCited} cited claim(s) are no longer verified — re-review or replace them`,
    details: [],
  });

  return findings;
}
