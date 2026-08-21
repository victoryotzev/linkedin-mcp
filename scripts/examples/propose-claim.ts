// Example: the evidence -> verified-claim flow, end to end.
//
// SAFE TO RUN. This writes to a throwaway data home under the OS temp
// directory and deletes it on exit. It never opens the member's real home, and
// every piece of content below is invented.
//
//   npx tsx scripts/examples/propose-claim.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, migrate, openDatabase } from '@linkedin-mcp/db';
import {
  checkCoverage,
  enableSourceFromDashboard,
  listArtifacts,
  proposeClaim,
  registerSource,
  runImport,
  seedCanonicalSections,
  seedCapabilities,
  verifyClaim,
} from '@linkedin-mcp/domain';

const home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-example-home-'));
const evidenceRoot = mkdtempSync(join(tmpdir(), 'linkedin-mcp-example-src-'));

try {
  // A tiny synthetic evidence source: one Markdown file in its own directory.
  mkdirSync(join(evidenceRoot, 'docs'), { recursive: true });
  writeFileSync(
    join(evidenceRoot, 'docs', 'notes.md'),
    '# Project notes\n\nBuilt a deterministic CSV importer with a 40-case test suite.\n',
    'utf8',
  );

  const { db, fts5 } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  migrate(db);
  seedCapabilities(db);
  seedCanonicalSections(db);
  const store = new ArtifactStore(join(home, 'artifacts'));

  // 1. Register the source. Registration alone imports nothing: a source
  //    arrives as 'pending_review' because enabling it is a human decision.
  const registered = registerSource(db, {
    path: evidenceRoot,
    kind: 'folder',
    trust: 'own_repo',
    label: 'Example evidence folder',
    dataHome: home,
  });
  console.log(`registered ${registered.id} (${registered.status})`);

  // 2. Enable, then import. The import copies bytes into the content-addressed
  //    artifact store and never modifies the original.
  const source = enableSourceFromDashboard(db, registered.id);
  const report = await runImport(db, store, source.id);
  console.log(
    `saw ${report.files_seen} file(s), imported ${report.files_imported}, rejected ${report.files_rejected}`,
  );

  const artifact = listArtifacts(db, { source_id: source.id }, fts5)[0];
  if (!artifact) throw new Error('nothing imported — cannot cite evidence');

  // 3. Propose a claim that cites that artifact. Proposing does not make it
  //    true; the claim starts unverified.
  const claim = proposeClaim(db, {
    statement: 'The importer parses CSV deterministically and is covered by a 40-case suite.',
    evidence: [{ artifact_id: artifact.id, location: {} }],
    method: 'manual',
  });
  console.log(`proposed ${claim.id} (${claim.state})`);

  // 4. Verification is the explicit human step. Only verified claims may back
  //    public profile text or a post draft.
  const verified = verifyClaim(db, { claim_id: claim.id, confirm: true, reviewer: 'example' });
  console.log(`verified ${verified.id} (${verified.state})`);

  // 5. Coverage scores arbitrary text against the verified corpus, so you can
  //    see which sentences are actually backed by evidence.
  const coverage = checkCoverage(db, {
    text: 'The importer parses CSV deterministically. It also cures baldness.',
  });
  for (const sentence of coverage.sentences) {
    console.log(`  [${sentence.status}] ${sentence.text}`);
  }

  db.close();
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  rmSync(evidenceRoot, { recursive: true, force: true, maxRetries: 3 });
}
