// Verifies that every eval answer is actually derivable from the server's
// tools against the seeded corpus. This is the ground-truth check: if a
// question's answer drifts, the harness fails here rather than in an
// evaluation run where the cause is ambiguous.
//
// Usage: LINKEDIN_MCP_HOME=<eval dir> npx tsx scripts/run-eval.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDatabase } from '@linkedin-mcp/db';
import {
  checkCoverage,
  currentRevision,
  latestValidation,
  listArtifacts,
  listCapabilities,
  listClaims,
  listConflicts,
  listObservations,
  listSources,
  getClaim,
  getClaimEvidence,
} from '@linkedin-mcp/domain';

const home = process.env['LINKEDIN_MCP_HOME'];
if (!home) throw new Error('set LINKEDIN_MCP_HOME to the seeded eval directory');
const { db, fts5 } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));

const questionsPath = fileURLToPath(
  new URL('../tests/fixtures/eval-questions.xml', import.meta.url),
);
const xml = readFileSync(questionsPath, 'utf8');
const expected = [...xml.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((m) => m[1]!.trim());

const actual: string[] = [];

// 1. verified claim count
actual.push(String(listClaims(db, { state: 'verified' }, fts5).length));

// 2. state of a specific claim
actual.push(getClaim(db, 'clm_eval09').state);

// 3. conflict type and members
const conflict = listConflicts(db)[0]!;
actual.push(
  `${conflict.type}; ${conflict.members
    .map((m) => m.claim_id)
    .sort()
    .join(' and ')}`,
);

// 4. draft coverage
const revision = currentRevision(db, 'drf_eval01');
const coverage = checkCoverage(db, { text: revision.body_text });
actual.push(`${coverage.supported_count}/${coverage.total_count}`);

// 5. other failing validation check
const validation = latestValidation(db, 'drf_eval01')!;
actual.push(
  validation.checks
    .filter((c) => !c.passed && c.check !== 'unsupported_claims')
    .map((c) => c.check)
    .join(', '),
);

// 6. capability status + blocker
const capability = listCapabilities(db, 'linkedin.publish_post')[0]!;
actual.push(`${capability.status}; ${capability.blockers.join(', ')}`);

// 7. rejected claim + reason
const rejected = listClaims(db, { state: 'rejected' }, fts5)[0]!;
actual.push(`${rejected.id}; ${rejected.rejected_reason}`);

// 8. artifacts from a named source
const alpha = listSources(db).find((s) => s.label === 'fixture-repo-alpha')!;
actual.push(String(listArtifacts(db, { source_id: alpha.id }, fts5).length));

// 9. latest impressions
actual.push(
  String(
    listObservations(db, { subject_ref: 'urn:li:share:FIX123', metric: 'impressions' })[0]!.value,
  ),
);

// 10. trust level of the rejected claim's source
actual.push(getClaimEvidence(db, 'clm_eval11')[0]!.source_trust);

let failures = 0;
expected.forEach((want, i) => {
  const got = actual[i] ?? '(no answer)';
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} Q${i + 1}: expected "${want}", derived "${got}"`);
});

console.log(
  `\n${expected.length - failures}/${expected.length} answers verified against the corpus`,
);
db.close();
process.exit(failures === 0 ? 0 : 1);
