import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  diffProfile,
  enableSourceFromDashboard,
  getProfile,
  importSnapshot,
  proposeClaim,
  registerSource,
  runImport,
  scoreProfile,
  seedCanonicalSections,
  updateSection,
  verifyClaim,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { makeZip } from '../helpers/makeZip.ts';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let home: string;
let evidenceDir: string;
let db: SqliteDriver;
let store: ArtifactStore;
let exportSourceId: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-prof-'));
  evidenceDir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-profev-'));
  const opened = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  db = opened.db;
  migrate(db);
  seedCanonicalSections(db);
  store = new ArtifactStore(join(home, 'artifacts'));

  const zipPath = join(evidenceDir, 'export.zip');
  writeFileSync(
    zipPath,
    makeZip([
      {
        name: 'Profile.csv',
        data: Buffer.from(
          'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
            'Alex,Rivera,,,,Full-Stack Developer,Builds local-first systems.,Software,,Ghent BE,,https://alex-rivera.example,\n',
        ),
      },
      {
        name: 'Positions.csv',
        data: Buffer.from(
          'Company Name,Title,Description,Location,Started On,Finished On\n' +
            'Vale Wind Power,Web developer,ERP work,Ghent,Jun 2020,\n',
        ),
      },
      {
        name: 'Skills.csv',
        data: Buffer.from('Name\nJavaScript\nPython\n'),
      },
    ]),
  );
  const source = registerSource(db, {
    path: zipPath,
    kind: 'linkedin_export',
    trust: 'personal_doc',
    label: 'export fixture',
    dataHome: home,
  });
  enableSourceFromDashboard(db, source.id);
  await runImport(db, store, source.id);
  exportSourceId = source.id;
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('snapshots + canonical profile', () => {
  it('imports a versioned snapshot from export CSVs and diffs against canonical', () => {
    const snapshot = importSnapshot(db, store, exportSourceId);
    expect(snapshot.version).toBe(1);
    expect(snapshot.fields['headline']?.value_text).toBe('Full-Stack Developer');
    expect(snapshot.fields['skills']?.value_text).toBe('JavaScript, Python');
    expect(snapshot.fields['experience']?.value_text).toContain('Vale Wind Power');

    // Canonical is empty -> every snapshot field shows as changed.
    const diff = diffProfile(db, 'canonical', 'snapshot:latest');
    expect(diff.every((f) => f.changed)).toBe(true);

    // Write a canonical headline matching the snapshot -> that field converges.
    const { artifactId } = seedSourceAndArtifact(db);
    const claim = proposeClaim(db, {
      statement: 'Alex works as a full-stack developer.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });
    updateSection(db, {
      section_key: 'headline',
      content_text: 'Full-Stack Developer',
      claim_ids: [claim.id],
      author: 'user',
      based_on_revision: null,
    });
    const diff2 = diffProfile(db, 'canonical', 'snapshot:latest');
    expect(diff2.find((f) => f.field_key === 'headline')?.changed).toBe(false);
  });

  it('enforces verified-claims-only and optimistic concurrency on canonical writes', () => {
    const { artifactId } = seedSourceAndArtifact(db);
    const candidate = proposeClaim(db, {
      statement: 'An unreviewed candidate statement.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'model_proposed',
    });

    expect(() =>
      updateSection(db, {
        section_key: 'about',
        content_text: 'cites an unverified claim',
        claim_ids: [candidate.id],
        author: 'mcp_host',
        based_on_revision: null,
      }),
    ).toThrowError(DomainError);

    const rev1 = updateSection(db, {
      section_key: 'about',
      content_text: 'first version',
      claim_ids: [],
      author: 'user',
      based_on_revision: null,
    });
    // Stale base (null again) must conflict now.
    try {
      updateSection(db, {
        section_key: 'about',
        content_text: 'second version',
        claim_ids: [],
        author: 'mcp_host',
        based_on_revision: null,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('REVISION_CONFLICT');
    }
    const rev2 = updateSection(db, {
      section_key: 'about',
      content_text: 'second version',
      claim_ids: [],
      author: 'mcp_host',
      based_on_revision: rev1.id,
    });
    expect(getProfile(db, ['about'])['about']?.id).toBe(rev2.id);
  });

  it('scores completeness, coverage, and freshness with explanations', () => {
    const findings0 = scoreProfile(db);
    expect(findings0.find((f) => f.dimension === 'completeness')?.score).toBe(0);

    const { artifactId } = seedSourceAndArtifact(db);
    const claim = proposeClaim(db, {
      statement: 'A verifiable statement for scoring.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
      review_by: '2026-01-01T00:00:00Z', // already past -> goes stale on sweep
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });
    updateSection(db, {
      section_key: 'headline',
      content_text: 'Backed headline',
      claim_ids: [claim.id],
      author: 'user',
      based_on_revision: null,
    });

    const findings1 = scoreProfile(db);
    expect(findings1.find((f) => f.dimension === 'completeness')?.score).toBeCloseTo(0.2);
    expect(findings1.find((f) => f.dimension === 'evidence_coverage')?.score).toBe(1);
    expect(findings1.find((f) => f.dimension === 'freshness')?.score).toBe(1);

    // Expire the cited claim -> freshness drops and names the offender.
    db.run("UPDATE claims SET state = 'expired' WHERE id = ?", claim.id);
    const findings2 = scoreProfile(db);
    expect(findings2.find((f) => f.dimension === 'freshness')?.score).toBe(0);
    expect(findings2.find((f) => f.dimension === 'evidence_coverage')?.details.join(' ')).toContain(
      claim.id,
    );
  });
});
