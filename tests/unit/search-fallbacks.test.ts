import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getArtifactDetail,
  listArtifacts,
  listClaims,
  markClaimAmbiguous,
  proposeClaim,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// Searching when the full-text index is not there.
//
// FTS5 is a compile-time option in SQLite, so a member's Node build may simply
// not have it — and a home restored from a build that did can have the table
// missing while the flag says otherwise. Search has to keep working either way:
// a LIKE scan is slower and less clever, but a search box that returns nothing
// on a corpus that plainly contains the word is indistinguishable from a bug,
// and it is the box the member uses to find the evidence behind a claim.
//
// What must NOT change with the index is meaning. A query is a literal string
// on both paths: FTS operators are neutralised by quoting, and LIKE wildcards
// are escaped, so `100%` finds the claim that says `100%` and not every claim.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;

beforeEach(() => {
  fixture = createFixture('search-fallbacks');
  seeded = seedHealthy(fixture);
});

afterEach(() => fixture.close());

/** The index is gone but the build still reports FTS5 — a half-restored home. */
function dropIndexes(): void {
  fixture.db.exec('DROP TABLE IF EXISTS claims_fts');
  fixture.db.exec('DROP TABLE IF EXISTS extractions_fts');
}

describe('finding a claim by its words', () => {
  it('finds it through the index', () => {
    const found = listClaims(fixture.db, { q: 'hash-chained' }, fixture.fts5);

    expect(found.length).toBeGreaterThan(0);
  });

  it('finds the same claim with no index at all', () => {
    const found = listClaims(fixture.db, { q: 'hash-chained' }, false);

    expect(found.map((c) => c.id)).toContain(seeded.candidateId);
  });

  it('falls back rather than failing when the index has gone missing', () => {
    dropIndexes();

    // The flag says the build has FTS5; the table says otherwise. Reporting no
    // results here would read as an empty corpus.
    const found = listClaims(fixture.db, { q: 'hash-chained' }, true);

    expect(found.map((c) => c.id)).toContain(seeded.candidateId);
  });

  it('treats a wildcard in the query as a character, not a wildcard', () => {
    proposeClaim(fixture.db, {
      statement: 'The importer refuses 100% of zip entries that traverse upward.',
      evidence: [{ artifact_id: seeded.artifactId, location: {} }],
      method: 'manual',
    });

    const literal = listClaims(fixture.db, { q: '100%' }, false);
    const everything = listClaims(fixture.db, {}, false);

    // Unescaped, `%` would match every claim in the ledger and the member would
    // conclude the search box does nothing.
    expect(literal.length).toBeGreaterThan(0);
    expect(literal.length).toBeLessThan(everything.length);
  });

  it('finds nothing, rather than everything, for a word that is not there', () => {
    expect(listClaims(fixture.db, { q: 'palaeography' }, false)).toEqual([]);
    expect(listClaims(fixture.db, { q: 'palaeography' }, fixture.fts5)).toEqual([]);
  });
});

describe('finding an artifact by its contents', () => {
  it('finds it with no index at all', () => {
    const found = listArtifacts(fixture.db, { q: 'hash-chained' }, false);

    expect(found.length).toBeGreaterThan(0);
  });

  it('falls back rather than failing when the index has gone missing', () => {
    dropIndexes();

    const found = listArtifacts(fixture.db, { q: 'hash-chained' }, true);

    expect(found.length).toBeGreaterThan(0);
  });

  it('escapes an underscore, which LIKE would otherwise treat as any character', () => {
    seedRealArtifact(fixture, 'The file is named repo_stats.json.', {
      relpath: 'NOTES.md',
    });

    const literal = listArtifacts(fixture.db, { q: 'repo_stats' }, false);

    expect(literal.length).toBe(1);
  });
});

describe('narrowing the ledger', () => {
  it('filters claims by sensitivity', () => {
    const all = listClaims(fixture.db, {}, false);
    const sensitivity = all[0]?.sensitivity;
    if (!sensitivity) return;

    const filtered = listClaims(fixture.db, { sensitivity }, false);

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((c) => c.sensitivity === sensitivity)).toBe(true);
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });

  it('filters claims by the artifact they cite', () => {
    const filtered = listClaims(fixture.db, { artifact_id: seeded.artifactId }, false);

    expect(filtered.length).toBeGreaterThan(0);
  });

  it('finds the claims a reviewer marked ambiguous', () => {
    markClaimAmbiguous(fixture.db, {
      claim_id: seeded.candidateId,
      confirm: true,
      reviewer: 'user:test',
      note: 'true of the CLI, not of the dashboard',
    });

    expect(listClaims(fixture.db, { state: 'ambiguous' }, false).map((c) => c.id)).toContain(
      seeded.candidateId,
    );
  });
});

describe('what a claim statement may be', () => {
  it('refuses one too short to mean anything', () => {
    expect(() =>
      proposeClaim(fixture.db, {
        statement: 'Fast',
        evidence: [{ artifact_id: seeded.artifactId, location: {} }],
        method: 'manual',
      }),
    ).toThrow(/8-500 characters/);
  });

  it('refuses one longer than any profile section could carry', () => {
    expect(() =>
      proposeClaim(fixture.db, {
        statement: `I ${'really '.repeat(80)}build software.`,
        evidence: [{ artifact_id: seeded.artifactId, location: {} }],
        method: 'manual',
      }),
    ).toThrow(/8-500 characters/);
  });
});

describe('an artifact with nothing extracted from it', () => {
  it('reports no preview rather than an empty one', () => {
    fixture.db.run('DELETE FROM extractions WHERE artifact_id = ?', seeded.artifactId);

    const detail = getArtifactDetail(fixture.db, fixture.store, seeded.artifactId);

    // null and '' are different answers: one says nothing was read, the other
    // says the file was read and is blank.
    expect(detail.preview).toBeNull();
    expect(detail.integrity_verified).toBe(true);
  });
});
