import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enableSourceFromDashboard,
  importSnapshot,
  latestSnapshot,
  registerSource,
  runImport,
} from '@linkedin-mcp/domain';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';
import { makePdf } from '../helpers/makePdf.ts';
import { makeZip } from '../helpers/makeZip.ts';

// Turning an imported source into a profile snapshot.
//
// A snapshot is what every later diff is measured against, so what it contains
// decides which patches the member is offered. A LinkedIn export gives the full
// picture; a profile PDF gives raw text and says so; anything else is refused
// rather than half-read.

let fixture: Fixture;
let evidence: string;

beforeEach(() => {
  fixture = createFixture('snapshot-sources');
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-snapev-'));
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

const PROFILE_CSV =
  'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\n' +
  'Alex,Rivera,,,,Full-Stack Web Developer,Builds local-first systems.,Software,,Ghent,,,\n';

const POSITIONS_CSV =
  'Company Name,Title,Description,Location,Started On,Finished On\n' +
  'Vale Wind Power,Web Developer,ERP platform,Ghent,Jun 2020,\n' +
  'Northgate Labs,Intern,,Ghent,Jan 2019,May 2019\n';

const EDUCATION_CSV =
  'School Name,Start Date,End Date,Notes,Degree Name,Activities\n' +
  'Northgate State University,2023,2026,,BSc,\n';

const SKILLS_CSV = 'Name\nTypeScript\nPython\n';

async function snapshotFrom(
  files: Array<{ name: string; data: Buffer }>,
  kind: 'linkedin_export' | 'document' | 'repo' = 'linkedin_export',
  fileName = 'export.zip',
) {
  const path = join(evidence, fileName);
  writeFileSync(path, kind === 'linkedin_export' ? makeZip(files) : files[0]!.data);
  const source = registerSource(fixture.db, {
    path,
    kind,
    trust: 'personal_doc',
    label: 'source',
    dataHome: fixture.dir,
  });
  enableSourceFromDashboard(fixture.db, source.id);
  await runImport(fixture.db, fixture.store, source.id);
  return { source, snapshot: importSnapshot(fixture.db, fixture.store, source.id) };
}

const fieldText = (key: string): string =>
  latestSnapshot(fixture.db)?.fields[key]?.value_text ?? '';

describe('a LinkedIn export', () => {
  it('reads the headline, summary, industry and location from Profile.csv', async () => {
    await snapshotFrom([{ name: 'Profile.csv', data: Buffer.from(PROFILE_CSV) }]);

    expect(fieldText('headline')).toBe('Full-Stack Web Developer');
    expect(fieldText('about')).toContain('local-first');
  }, 60_000);

  it('reads every position, including one still running', async () => {
    await snapshotFrom([
      { name: 'Profile.csv', data: Buffer.from(PROFILE_CSV) },
      { name: 'Positions.csv', data: Buffer.from(POSITIONS_CSV) },
    ]);

    const experience = fieldText('experience');
    expect(experience).toContain('Web Developer');
    expect(experience).toContain('Vale Wind Power');
    // An open-ended role has to read as current, not as a missing date.
    expect(experience).toContain('present');
    expect(experience).toContain('Northgate Labs');
  }, 60_000);

  it('reads education, and skills as a list', async () => {
    await snapshotFrom([
      { name: 'Profile.csv', data: Buffer.from(PROFILE_CSV) },
      { name: 'Education.csv', data: Buffer.from(EDUCATION_CSV) },
      { name: 'Skills.csv', data: Buffer.from(SKILLS_CSV) },
    ]);

    expect(fieldText('education')).toContain('Northgate State University');
    expect(fieldText('education')).toContain('BSc');
    expect(fieldText('skills')).toContain('TypeScript');
    expect(fieldText('skills')).toContain('Python');
  }, 60_000);

  it('skips a position row that names neither a company nor a title', async () => {
    await snapshotFrom([
      { name: 'Profile.csv', data: Buffer.from(PROFILE_CSV) },
      {
        name: 'Positions.csv',
        data: Buffer.from(`${POSITIONS_CSV},,,,Jan 2020,Feb 2020\n`),
      },
    ]);

    // An empty row in an export is noise, not a job.
    expect(fieldText('experience').split('\n').filter(Boolean).length).toBe(2);
  }, 60_000);

  it('warns rather than failing when Profile.csv is missing', async () => {
    const { snapshot } = await snapshotFrom([
      { name: 'Positions.csv', data: Buffer.from(POSITIONS_CSV) },
    ]);

    // The rest of the export is still worth having, and the gap is stated.
    expect(snapshot.warnings.join(' ')).toMatch(/Profile\.csv/i);
    expect(fieldText('experience')).toContain('Vale Wind Power');
  }, 60_000);

  it('refuses an export with nothing readable in it at all', async () => {
    const path = join(evidence, 'empty.zip');
    writeFileSync(path, makeZip([{ name: 'notes.txt', data: Buffer.from('nothing useful') }]));
    const source = registerSource(fixture.db, {
      path,
      kind: 'linkedin_export',
      trust: 'personal_doc',
      label: 'empty export',
      dataHome: fixture.dir,
    });
    enableSourceFromDashboard(fixture.db, source.id);
    await runImport(fixture.db, fixture.store, source.id);

    // A snapshot with no fields would read as "LinkedIn has nothing", which
    // would propose deleting the member's whole profile.
    expect(() => importSnapshot(fixture.db, fixture.store, source.id)).toThrow(
      /no snapshot fields/i,
    );
  }, 60_000);
});

describe('a profile PDF', () => {
  it('is read as raw text, and says that it is lossy', async () => {
    const { snapshot } = await snapshotFrom(
      [{ name: 'profile.pdf', data: makePdf(['Alex Rivera', 'Full-Stack Web Developer']) }],
      'document',
      'profile.pdf',
    );

    expect(fieldText('raw_profile_text')).toContain('Alex Rivera');
    // The member has to know this is the weakest of the three sources, or they
    // will trust a diff built on text a PDF layout mangled.
    expect(snapshot.warnings.join(' ')).toMatch(/lossy|raw text/i);
    expect(snapshot.warnings.join(' ')).toMatch(/export|DMA/);
  }, 60_000);

  it('refuses a document with no readable text', async () => {
    const path = join(evidence, 'broken.pdf');
    writeFileSync(path, Buffer.from('not a pdf at all'));
    const source = registerSource(fixture.db, {
      path,
      kind: 'document',
      trust: 'personal_doc',
      label: 'broken pdf',
      dataHome: fixture.dir,
    });
    enableSourceFromDashboard(fixture.db, source.id);
    await runImport(fixture.db, fixture.store, source.id);

    expect(() => importSnapshot(fixture.db, fixture.store, source.id)).toThrow(
      /no extracted text/i,
    );
  }, 60_000);
});

describe('any other kind of source', () => {
  it('is refused rather than half-read', async () => {
    writeFileSync(join(evidence, 'README.md'), '# Project\n\nA parser.\n');
    const source = registerSource(fixture.db, {
      path: evidence,
      kind: 'repo',
      trust: 'own_repo',
      label: 'a repository',
      dataHome: fixture.dir,
    });
    enableSourceFromDashboard(fixture.db, source.id);
    await runImport(fixture.db, fixture.store, source.id);

    // A repository says nothing about what is on the member's LinkedIn profile.
    expect(() => importSnapshot(fixture.db, fixture.store, source.id)).toThrow(
      /linkedin_export or document/i,
    );
  }, 60_000);
});

describe('successive snapshots', () => {
  it('keeps the newest as the one diffs are measured against', async () => {
    await snapshotFrom(
      [{ name: 'Profile.csv', data: Buffer.from(PROFILE_CSV) }],
      'linkedin_export',
      'v1.zip',
    );
    const first = latestSnapshot(fixture.db)?.id;

    await snapshotFrom(
      [
        {
          name: 'Profile.csv',
          data: Buffer.from(PROFILE_CSV.replace('Full-Stack Web Developer', 'Staff Engineer')),
        },
      ],
      'linkedin_export',
      'v2.zip',
    );

    expect(latestSnapshot(fixture.db)?.id).not.toBe(first);
    expect(fieldText('headline')).toBe('Staff Engineer');
  }, 60_000);
});
