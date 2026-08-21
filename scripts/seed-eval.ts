// Builds the evaluation corpus: a small, fully synthetic ledger with known
// answers. Nothing here touches the member's real data — the eval home is a
// throwaway directory so an evaluator can be pointed at it safely.
//
// Usage: LINKEDIN_MCP_HOME=<dir> npx tsx scripts/seed-eval.ts
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore, migrate, openDatabase, withWriteTx } from '@linkedin-mcp/db';
import {
  detectConflicts,
  ensureLocalAccount,
  importObservations,
  statementHash,
  rejectClaim,
  seedCanonicalSections,
  seedCapabilities,
  updateSection,
  validateDraft,
  verifyClaim,
  writeDraft,
} from '@linkedin-mcp/domain';
import { newId } from '@linkedin-mcp/shared';

const home = process.env['LINKEDIN_MCP_HOME'];
if (!home) throw new Error('set LINKEDIN_MCP_HOME to a throwaway directory');
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const { db } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
migrate(db);
seedCapabilities(db);
seedCanonicalSections(db);
ensureLocalAccount(db);
const store = new ArtifactStore(join(home, 'artifacts'));

// --- sources and artifacts ---------------------------------------------
function source(id: string, label: string, trust: string, kind = 'repo'): string {
  db.run(
    `INSERT INTO sources (id, kind, root_path, label, trust, status, registered_at)
     VALUES (?, ?, ?, ?, ?, 'enabled', '2026-01-01T00:00:00Z')`,
    id,
    kind,
    `C:\\eval\\${label.replace(/\s+/g, '-')}`,
    label,
    trust,
  );
  return id;
}

function artifact(id: string, sourceId: string, relpath: string, body: string): string {
  const put = store.put(Buffer.from(body, 'utf8'));
  const runId = newId('run');
  db.run(
    'INSERT INTO import_runs (id, source_id, started_at) VALUES (?, ?, ?)',
    runId,
    sourceId,
    '2026-01-01T00:00:00Z',
  );
  db.run(
    `INSERT INTO artifacts (id, source_id, source_relpath, sha256, size_bytes, mime, imported_at, import_run_id)
     VALUES (?, ?, ?, ?, ?, 'text/plain', '2026-01-01T00:00:00Z', ?)`,
    id,
    sourceId,
    relpath,
    put.sha256,
    body.length,
    runId,
  );
  db.run(
    `INSERT INTO extractions (id, artifact_id, parser_name, parser_version, status, text, created_at)
     VALUES (?, ?, 'text', 1, 'ok', ?, '2026-01-01T00:00:00Z')`,
    newId('ext'),
    id,
    body,
  );
  return id;
}

// Renaming a parent row and its children has to happen inside one deferred
// transaction, or the intermediate state trips the foreign keys.
function renameWithDeferredFks(fn: () => void): void {
  withWriteTx(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    fn();
  });
}

const alpha = source('src_evalalpha', 'fixture-repo-alpha', 'own_repo');
const clone = source('src_evalclone', 'fixture-clone-beta', 'local_clone_reference');
const docs = source('src_evaldocs', 'fixture-documents', 'personal_doc', 'document');

artifact('art_eval001', alpha, 'README.md', 'Fixture alpha service. Ships an HTTP API and tests.');
artifact(
  'art_eval002',
  alpha,
  'package.json',
  '{"name":"fixture-alpha","dependencies":{"zod":"^4.0.0"}}',
);
artifact('art_eval003', alpha, '__repo_stats__.json', '{"files_total":187}');
artifact('art_eval004', clone, 'README.md', 'Upstream project cloned for reference only.');
artifact(
  'art_eval005',
  docs,
  'cv.txt',
  'Evaluation fixture CV. Role: fixture engineer since 2021.',
);

// --- claims: 6 verified, 2 candidate, 2 ambiguous, 1 rejected, 1 expired
interface Spec {
  id: string;
  statement: string;
  state: 'verified' | 'candidate' | 'ambiguous' | 'rejected' | 'expired';
  artifact: string;
}
const CLAIMS: Spec[] = [
  {
    id: 'clm_eval01',
    statement: 'The alpha service exposes an HTTP API with automated tests.',
    state: 'verified',
    artifact: 'art_eval001',
  },
  {
    id: 'clm_eval02',
    statement: 'The alpha service validates its inputs with Zod version 4.',
    state: 'verified',
    artifact: 'art_eval002',
  },
  {
    id: 'clm_eval03',
    statement: 'The fixture engineer has held that role since 2021.',
    state: 'verified',
    artifact: 'art_eval005',
  },
  {
    id: 'clm_eval04',
    statement: 'The alpha repository contains 187 test files.',
    state: 'ambiguous',
    artifact: 'art_eval003',
  },
  {
    id: 'clm_eval05',
    statement: 'The alpha service ships a documented README.',
    state: 'verified',
    artifact: 'art_eval001',
  },
  {
    id: 'clm_eval06',
    statement: 'The fixture documents include a curriculum vitae.',
    state: 'verified',
    artifact: 'art_eval005',
  },
  {
    id: 'clm_eval07',
    statement: 'The alpha service supports webhook delivery.',
    state: 'candidate',
    artifact: 'art_eval001',
  },
  {
    id: 'clm_eval08',
    statement: 'The alpha service runs nightly performance benchmarks.',
    state: 'candidate',
    artifact: 'art_eval001',
  },
  {
    id: 'clm_eval09',
    statement: 'The alpha repository contains 203 test files.',
    state: 'ambiguous',
    artifact: 'art_eval003',
  },
  {
    id: 'clm_eval10',
    statement: 'The fixture engineer maintains the alpha service.',
    state: 'verified',
    artifact: 'art_eval005',
  },
  {
    id: 'clm_eval11',
    statement: 'I built the upstream beta project from scratch.',
    state: 'rejected',
    artifact: 'art_eval004',
  },
  {
    id: 'clm_eval12',
    statement: 'The alpha service was benchmarked in early 2025.',
    state: 'expired',
    artifact: 'art_eval001',
  },
];

for (const spec of CLAIMS) {
  // Fixed IDs are inserted directly (rather than renaming after the fact,
  // which would orphan the evidence rows) so eval answers stay stable.
  db.run(
    `INSERT INTO claims (id, statement, statement_hash, state, method, sensitivity, created_at, updated_at)
     VALUES (?, ?, ?, 'candidate', 'parser', 'public', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    spec.id,
    spec.statement,
    statementHash(spec.statement),
  );
  db.run(
    "INSERT INTO claim_evidence (claim_id, artifact_id, location_json, role) VALUES (?, ?, '{}', 'primary')",
    spec.id,
    spec.artifact,
  );
  if (spec.state === 'verified') verifyClaim(db, { claim_id: spec.id, confirm: true });
  if (spec.state === 'rejected') {
    rejectClaim(db, {
      claim_id: spec.id,
      reason: 'local clone, authorship claim not permitted',
      confirm: true,
      reviewer: 'system:eval-fixture',
    });
  }
  if (spec.state === 'ambiguous')
    db.run("UPDATE claims SET state = 'ambiguous' WHERE id = ?", spec.id);
  if (spec.state === 'expired') db.run("UPDATE claims SET state = 'expired' WHERE id = ?", spec.id);
}

// The two ambiguous count claims contradict each other.
db.run("UPDATE claims SET state = 'candidate' WHERE id IN ('clm_eval04','clm_eval09')");
const conflicts = detectConflicts(db);
db.run("UPDATE claims SET state = 'ambiguous' WHERE id IN ('clm_eval04','clm_eval09')");
const conflictId = conflicts.created[0];
if (!conflictId) throw new Error('eval fixture did not create the expected claim conflict');
renameWithDeferredFks(() => {
  db.run('UPDATE claim_conflicts SET id = ? WHERE id = ?', 'cfl_eval01', conflictId);
  db.run(
    'UPDATE claim_conflict_members SET conflict_id = ? WHERE conflict_id = ?',
    'cfl_eval01',
    conflictId,
  );
});

// --- canonical section, draft, observations -----------------------------
updateSection(db, {
  section_key: 'headline',
  content_text: 'Fixture Engineer — HTTP APIs and automated tests',
  claim_ids: ['clm_eval01', 'clm_eval03'],
  author: 'user',
  based_on_revision: null,
});

const { draft } = writeDraft(db, {
  slug: 'eval-draft',
  body_text: [
    'The alpha service exposes an HTTP API with automated tests.',
    'The alpha service validates its inputs with Zod version 4.',
    'The fixture engineer has held that role since 2021.',
    'It already serves 10000 users.',
    'The alpha service ships a documented README.',
  ].join(' '),
});
renameWithDeferredFks(() => {
  db.run('UPDATE post_drafts SET id = ? WHERE id = ?', 'drf_eval01', draft.id);
  db.run('UPDATE draft_revisions SET draft_id = ? WHERE draft_id = ?', 'drf_eval01', draft.id);
});
validateDraft(db, 'drf_eval01');

importObservations(db, [
  {
    subject_ref: 'urn:li:share:FIX123',
    metric: 'impressions',
    value: 120,
    observed_at: '2026-08-01',
  },
  {
    subject_ref: 'urn:li:share:FIX123',
    metric: 'impressions',
    value: 340,
    observed_at: '2026-08-03',
  },
  {
    subject_ref: 'urn:li:share:FIX123',
    metric: 'impressions',
    value: 410,
    observed_at: '2026-08-05',
  },
]);

console.log(
  JSON.stringify(
    {
      home,
      claims: db.all('SELECT state, COUNT(*) AS n FROM claims GROUP BY state'),
      conflicts: db.all('SELECT id, type, state FROM claim_conflicts'),
      artifacts: Number(db.get('SELECT COUNT(*) AS n FROM artifacts')?.['n']),
    },
    null,
    2,
  ),
);
db.close();
