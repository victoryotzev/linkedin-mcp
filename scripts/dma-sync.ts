import { join } from 'node:path';
import { migrate, openDatabase } from '@linkedin-mcp/db';
import {
  createSecretStore,
  laneToken,
  latestSnapshot,
  listPublishedPosts,
  requireCapability,
  syncFromDma,
} from '@linkedin-mcp/domain';
import { DmaClient } from '@linkedin-mcp/linkedin';
import { resolveDataHome } from '@linkedin-mcp/shared';

// Runs when a human runs it. There is deliberately no scheduler anywhere in
// this repo — a product decision, not a legal one. LinkedIn's Portability API
// terms govern what may be stored and for how long and forbid obtaining data
// outside the Portability APIs, but they place no prohibition on refreshing on
// a cadence; LinkedIn's own Changelog guidance recommends polling roughly once
// an hour. An earlier comment here claimed the terms forbade it. They do not.

const home = resolveDataHome();
const { db } = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
migrate(db);

// The gate runs before the client is constructed, so a closed lane opens no
// socket at all.
requireCapability(db, 'linkedin.dma_snapshot');

const token = await laneToken(db, createSecretStore(db, home), 'read');
const report = await syncFromDma(db, new DmaClient({ accessToken: token }));

// rows_fetched is what LinkedIn returned; imported is what that became here —
// 7 profile fields, 1 rendered field per profile domain, N posts. Printing only
// the second under a "rows" label reads as though LinkedIn sent one position.
console.log('domains:');
for (const domain of report.domains) {
  console.log(
    `  ${domain.domain.padEnd(18)} ${domain.status.padEnd(21)} ${String(domain.rows_fetched).padStart(4)} row(s) fetched → ${domain.imported} imported`,
  );
}
console.log(
  `snapshot: ${report.snapshot_id ?? '(none)'}${report.observation.snapshot_created ? '' : ' (unchanged content — reused)'}`,
);
console.log(`posts imported: ${report.posts_imported}`);
console.log(`freshness: ${report.freshness.status} (guarantee: ${report.freshness.guarantee})`);
for (const reason of report.freshness.reasons) console.log(`  - ${reason}`);
console.log(`next: ${report.freshness.recommended_next_action}`);

const snapshot = latestSnapshot(db);
if (snapshot) {
  console.log(`\nsnapshot ${snapshot.id} (${snapshot.source_kind}):`);
  for (const [key, field] of Object.entries(snapshot.fields)) {
    console.log(`  ${key.padEnd(12)} ${String(field.value_text ?? '').slice(0, 90)}`);
  }
}

const posts = listPublishedPosts(db);
const byLanguage = posts.reduce<Record<string, number>>((acc, post) => {
  const key = post.language_guess ?? 'unknown';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nposts on file: ${posts.length} ${JSON.stringify(byLanguage)}`);
const dated = posts
  .filter((p) => p.posted_at)
  .sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
if (dated.length > 0) {
  console.log(
    `range: ${String(dated[0]!.posted_at).slice(0, 10)} → ${String(dated.at(-1)!.posted_at).slice(0, 10)}`,
  );
}

db.close();
