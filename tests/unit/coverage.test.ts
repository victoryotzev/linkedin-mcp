import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { checkCoverage, proposeClaim, verifyClaim } from '@linkedin-mcp/domain';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let artifactId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-cov-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
  const verify = (statement: string) => {
    const c = proposeClaim(db, {
      statement,
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(db, { claim_id: c.id, confirm: true });
  };
  verify('Built a construction ERP with 89 API routes and 181 test files.');
  verify('Shipped a cPanel MCP server exposing sixty curated tools.');
  verify('The portfolio site runs Playwright tests across five device profiles.');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('evidence coverage', () => {
  it('maps supported sentences to claims and flags unsupported ones', () => {
    const text =
      'I built a construction ERP with 89 API routes. ' +
      'My cPanel MCP server exposes sixty curated tools. ' +
      'It already serves ten thousand happy enterprise customers.';
    const report = checkCoverage(db, { text });
    expect(report.total_count).toBe(3);
    expect(report.supported_count).toBe(2);
    expect(report.sentences[0]!.status).toBe('supported');
    expect(report.sentences[0]!.claim_ids.length).toBeGreaterThan(0);
    expect(report.sentences[2]!.status).toBe('unsupported');
    expect(report.sentences[2]!.claim_ids).toHaveLength(0);
  });

  it('is content-addressed: identical text and corpus return the same report', () => {
    const text = 'The portfolio site runs Playwright tests across five device profiles.';
    const first = checkCoverage(db, { text });
    const second = checkCoverage(db, { text });
    expect(second.id).toBe(first.id);
  });

  it('rescores when a claim is verified, instead of serving a stale report', () => {
    const text = 'Alex completed a bachelor thesis on renovating deployed software.';
    const before = checkCoverage(db, { text });
    expect(before.sentences[0]!.status).toBe('unsupported');

    const claim = proposeClaim(db, {
      statement: 'Alex completed a bachelor thesis about renovating deployed software.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });

    const after = checkCoverage(db, { text });
    expect(after.id).not.toBe(before.id);
    expect(after.corpus_fingerprint).not.toBe(before.corpus_fingerprint);
    expect(after.sentences[0]!.status).toBe('supported');
    expect(after.sentences[0]!.claim_ids).toContain(claim.id);
  });

  it('only verified claims count as support', () => {
    proposeClaim(db, {
      statement: 'Candidate-only statement about quantum blockchains.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'model_proposed',
    });
    const report = checkCoverage(db, {
      text: 'A candidate-only statement about quantum blockchains.',
    });
    expect(report.sentences[0]!.status).toBe('unsupported');
  });
});
