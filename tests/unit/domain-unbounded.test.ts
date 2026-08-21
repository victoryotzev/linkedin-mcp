import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listArtifacts, listClaims, proposeClaim } from '@linkedin-mcp/domain';
import { createFixture, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// A guard against a convenience that would break the product's core promise.
//
// The dashboard needs paging. The obvious way to get it is to add limit/offset
// to listClaims and listArtifacts — and that would be wrong, because both are
// shared with the MCP tool surface, which paginates in its own transport layer
// (linkedin-mcp-server/src/pagination.ts) over an unbounded call. A default limit
// on either would silently truncate the evidence corpus the model reasons over,
// and a partial corpus that looks complete is the one failure this system
// cannot tolerate.
//
// The dashboard pages in its route layer instead. This test exists so nobody
// "helpfully" moves it into the domain later.

const COUNT = 60;

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture('unbounded');
});

afterEach(() => fixture.close());

describe('domain list functions stay unbounded', () => {
  it('returns every claim, with no default limit', () => {
    const { artifactId } = seedRealArtifact(fixture, 'fixture evidence text');
    for (let index = 0; index < COUNT; index += 1) {
      proposeClaim(fixture.db, {
        statement: `Fixture claim number ${index} about the corpus contents.`,
        evidence: [{ artifact_id: artifactId, location: {} }],
        method: 'parser',
      });
    }
    expect(listClaims(fixture.db, {}, fixture.fts5)).toHaveLength(COUNT);
    expect(listClaims(fixture.db, { state: 'candidate' }, fixture.fts5)).toHaveLength(COUNT);
  });

  it('returns every artifact, with no default limit', () => {
    for (let index = 0; index < COUNT; index += 1) {
      seedRealArtifact(fixture, `artifact body number ${index}`, {
        relpath: `docs/file-${index}.md`,
      });
    }
    expect(listArtifacts(fixture.db, {}, fixture.fts5)).toHaveLength(COUNT);
  });
});
