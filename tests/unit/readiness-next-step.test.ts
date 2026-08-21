import { afterEach, describe, expect, it } from 'vitest';
import {
  enableSourceFromDashboard,
  proposeClaim,
  readinessReport,
  verifyClaim,
} from '@linkedin-mcp/domain';
import {
  createFixture,
  seedPendingSource,
  seedRealArtifact,
  type Fixture,
} from '../helpers/fixtures.ts';

// The one sentence a member is given about what to do next.
//
// The readiness report ends with a single recommendation, chosen by walking the
// corpus from nothing towards ready. It matters more than it looks: it is the
// only instruction on the first-run screen, and pointing someone at the wrong
// step is how they conclude the product does not work.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function home(label: string): Fixture {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  return fixture;
}

const nextStep = (fixture: Fixture): string =>
  readinessReport(fixture.db, { home: fixture.dir }).next_step;

describe('the recommended next step', () => {
  it('asks for evidence when the home is empty', () => {
    const fixture = home('readiness-empty');

    // Nothing at all: the three ways in are a CV, a folder, or typing.
    expect(nextStep(fixture)).toMatch(/CV|folder|description you type/i);
  });

  it('asks for an ENABLE decision while a source is awaiting one', () => {
    const fixture = home('readiness-pending');
    seedPendingSource(fixture.db);

    // A registered source is not consent. Until one is enabled, that is the
    // only thing worth doing.
    expect(nextStep(fixture)).toMatch(/ENABLE <source_id>|review each registered source/i);
  });

  it('asks for an import once a source is enabled but nothing has been read', () => {
    const fixture = home('readiness-no-artifacts');
    const pendingId = seedPendingSource(fixture.db);
    enableSourceFromDashboard(fixture.db, pendingId);

    expect(nextStep(fixture)).toMatch(/import from an enabled source/i);
  });

  it('asks for claims once there are artifacts but nothing has been proposed', () => {
    const fixture = home('readiness-no-claims');
    seedRealArtifact(fixture, 'The project ships a deterministic CSV parser.');

    expect(nextStep(fixture)).toMatch(/propose claims/i);
  });

  it('asks for a review while candidates are waiting, naming how many', () => {
    const fixture = home('readiness-candidates');
    const { artifactId } = seedRealArtifact(fixture, 'The project ships a CSV parser.');
    proposeClaim(fixture.db, {
      statement: 'The project ships a CSV parser.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });

    const step = nextStep(fixture);
    expect(step).toMatch(/review 1 candidate claim/i);
    // And why it matters: only verified claims can back profile text or a post.
    expect(step).toMatch(/only verified claims/i);
  });

  it('says the member is ready once something is verified', () => {
    const fixture = home('readiness-ready');
    const { artifactId } = seedRealArtifact(fixture, 'The project ships a CSV parser.');
    const claim = proposeClaim(fixture.db, {
      statement: 'The project ships a CSV parser.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    verifyClaim(fixture.db, { claim_id: claim.id, confirm: true, reviewer: 'user:test' });

    expect(nextStep(fixture)).toMatch(/ready/i);
    expect(nextStep(fixture)).toMatch(/profile section|draft a post/i);
  });
});

describe('the counts the report carries', () => {
  it('separates enabled sources from ones awaiting a decision', () => {
    const fixture = home('readiness-counts');
    const pendingId = seedPendingSource(fixture.db);
    seedPendingSource(fixture.db);
    enableSourceFromDashboard(fixture.db, pendingId);

    const report = readinessReport(fixture.db, { home: fixture.dir });

    expect(report.counts.sources_enabled).toBe(1);
    expect(report.counts.sources_pending).toBe(1);
  });

  it('counts artifacts, candidates and verified claims separately', () => {
    const fixture = home('readiness-claim-counts');
    const { artifactId } = seedRealArtifact(fixture, 'The project ships a CSV parser.');
    const candidate = proposeClaim(fixture.db, {
      statement: 'The project ships a CSV parser.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    const verified = proposeClaim(fixture.db, {
      statement: 'The project has a test suite.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(fixture.db, { claim_id: verified.id, confirm: true, reviewer: 'user:test' });

    const report = readinessReport(fixture.db, { home: fixture.dir });

    expect(report.counts.artifacts).toBe(1);
    expect(report.counts.claims_awaiting_review).toBe(1);
    expect(report.counts.claims_verified).toBe(1);
    expect(candidate.state).toBe('candidate');
  });
});
