// Example: verified claims -> post draft -> deterministic validation.
//
// SAFE TO RUN. This writes to a throwaway data home under the OS temp
// directory and deletes it on exit. It never opens the member's real home, and
// every piece of content below is invented.
//
// Validation is deterministic and local: no model decides whether a draft is
// publishable. A draft that asserts something the claim ledger cannot back is
// reported as unsupported, which is the whole point of the evidence ledger.
//
//   npx tsx scripts/examples/validate-draft.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, migrate, openDatabase } from '@linkedin-mcp/db';
import {
  enableSourceFromDashboard,
  listArtifacts,
  proposeClaim,
  registerSource,
  runImport,
  seedCanonicalSections,
  seedCapabilities,
  validateDraft,
  verifyClaim,
  writeDraft,
} from '@linkedin-mcp/domain';

const home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-example-home-'));
const evidenceRoot = mkdtempSync(join(tmpdir(), 'linkedin-mcp-example-src-'));

try {
  mkdirSync(join(evidenceRoot, 'docs'), { recursive: true });
  writeFileSync(
    join(evidenceRoot, 'docs', 'notes.md'),
    '# Project notes\n\nShipped a local-first backup command with verified restore.\n',
    'utf8',
  );

  const { db, fts5 } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);
  const store = new ArtifactStore(join(home, 'artifacts'));

  const source = enableSourceFromDashboard(
    db,
    registerSource(db, {
      path: evidenceRoot,
      kind: 'folder',
      trust: 'own_repo',
      label: 'Example evidence folder',
      dataHome: home,
    }).id,
  );
  await runImport(db, store, source.id);
  const artifact = listArtifacts(db, { source_id: source.id }, fts5)[0];
  if (!artifact) throw new Error('nothing imported — cannot cite evidence');

  const claim = proposeClaim(db, {
    statement: 'Shipped a local-first backup command with verified restore.',
    evidence: [{ artifact_id: artifact.id, location: {} }],
    method: 'manual',
  });
  verifyClaim(db, { claim_id: claim.id, confirm: true, reviewer: 'example' });

  // One sentence the ledger backs, one invented claim it does not. The
  // unsupported_claims check is what catches the second one.
  const { draft } = writeDraft(db, {
    body_text:
      'Shipped a local-first backup command with verified restore. It cut our recovery time by 87%.',
    visibility: 'PUBLIC',
  });

  const report = validateDraft(db, draft.id);
  console.log(`draft ${draft.id}`);
  for (const check of report.checks) {
    console.log(`  [${check.passed ? 'pass' : 'FAIL'}] ${check.check}`);
  }

  db.close();
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  rmSync(evidenceRoot, { recursive: true, force: true, maxRetries: 3 });
}
