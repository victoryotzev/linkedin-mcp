// Onboarding importer: registers + imports the user's evidence documents.
// Run with: npx tsx scripts/onboard-import.ts <path> <kind> <trust> <label>
//
// NOTE on enabling: flipping a source to 'enabled' is a human-authority action.
// This explicit CLI is the dashboard-free control path: it calls the same
// domain service as the dashboard, at the user's direct terminal request. The
// MCP tool surface still has no enable path.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore, migrate, openDatabase } from '@linkedin-mcp/db';
import {
  enableSourceFromDashboard,
  listSources,
  registerSource,
  runImport,
  seedCapabilities,
} from '@linkedin-mcp/domain';
import type { SourceKind, SourceTrust } from '@linkedin-mcp/domain';
import { resolveDataHome } from '@linkedin-mcp/shared';

const [path, kind, trust, ...labelParts] = process.argv.slice(2);
if (!path || !kind || !trust || labelParts.length === 0) {
  console.error('usage: tsx scripts/onboard-import.ts <path> <kind> <trust> <label...>');
  process.exit(2);
}
const label = labelParts.join(' ');

const home = resolveDataHome();
const { db } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
migrate(db);
seedCapabilities(db);
const store = new ArtifactStore(join(home, 'artifacts'));

// Untouched-original check: byte hash for files; directory sources are
// opened read-only by the scanner, so mtime of the root stands in.
const isFile = statSync(path).isFile();
const fingerprint = () =>
  isFile
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : String(statSync(path).mtimeMs);
const originalHash = fingerprint();

let source = listSources(db).find((s) => s.root_path.toLowerCase() === path.toLowerCase());
source ??= registerSource(db, {
  path,
  kind: kind as SourceKind,
  trust: trust as SourceTrust,
  label,
  dataHome: home,
});
if (source.status === 'pending_review') {
  source = enableSourceFromDashboard(db, source.id);
}

const report = await runImport(db, store, source.id);
const afterHash = fingerprint();

console.log(
  JSON.stringify(
    {
      source_id: source.id,
      label,
      report: { ...report, rejects: report.rejects.slice(0, 20) },
      original_untouched: originalHash === afterHash,
    },
    null,
    2,
  ),
);
db.close();
