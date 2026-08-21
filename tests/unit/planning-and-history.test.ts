import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  containsCyrillic,
  importPublishedPosts,
  listCalendar,
  listPillars,
  listPublishedPosts,
  upsertCalendarEntry,
  upsertPillar,
  voiceProfile,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// Planning entries, and reading a member's own post history back out of an
// export.
//
// Both are places where accepting bad input quietly is worse than refusing it.
// A calendar date that is not a real date becomes a plan the member never sees
// again; a Shares export missing its columns becomes a "successful" import of
// nothing, which is the single most misleading outcome an importer can produce.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;

beforeEach(() => {
  fixture = createFixture('planning-history');
  seeded = seedHealthy(fixture);
});

afterEach(() => fixture.close());

const SHARES_HEADER = 'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n';

function importShares(csv: string): { imported: number; skipped: number } {
  const { artifactId } = seedRealArtifact(fixture, csv, { relpath: 'Shares.csv' });
  return importPublishedPosts(fixture.db, fixture.store, artifactId);
}

describe('content pillars', () => {
  it('creates one, then edits it in place rather than making a second', () => {
    const created = upsertPillar(fixture.db, {
      name: 'Evidence tooling',
      description: 'Local-first systems.',
    });

    const edited = upsertPillar(fixture.db, {
      id: created.id,
      name: 'Evidence tooling',
      description: 'Local-first systems, mostly on Windows.',
      audience: 'engineers who audit their own claims',
    });

    // Same id, so every draft already filed under this pillar follows the
    // rename instead of being orphaned by it.
    expect(edited.id).toBe(created.id);
    expect(edited.description).toMatch(/mostly on Windows/);
    expect(edited.audience).toMatch(/engineers/);
    expect(listPillars(fixture.db).filter((p) => p.name === 'Evidence tooling')).toHaveLength(1);
  });
});

describe('calendar entries', () => {
  it('needs a date, because an entry with none can never come up again', () => {
    expect(() => upsertCalendarEntry(fixture.db, { status: 'planned' })).toThrow(
      /requires intended_date/i,
    );
  });

  it('refuses something that is not an ISO-8601 date', () => {
    for (const intended_date of ['next tuesday', '03/04/2026', '2026-3-4', '', '2026']) {
      expect(() => upsertCalendarEntry(fixture.db, { intended_date }), intended_date).toThrow(
        /ISO-8601/i,
      );
    }
  });

  it('refuses a date that looks well-formed but is not a day', () => {
    // Date.parse would roll 2026-02-30 forward to March, filing the post three
    // days after the member meant it and never saying so.
    expect(() => upsertCalendarEntry(fixture.db, { intended_date: '2026-02-30' })).toThrow(
      /not a real calendar date/i,
    );
  });

  it('accepts a plain date and a full timestamp', () => {
    const day = upsertCalendarEntry(fixture.db, { intended_date: '2026-09-01' });
    const moment = upsertCalendarEntry(fixture.db, {
      intended_date: '2026-09-02T08:30:00.000Z',
    });

    expect(listCalendar(fixture.db).map((e) => e.id)).toEqual(
      expect.arrayContaining([day.id, moment.id]),
    );
  });

  it('edits an entry in place and keeps the fields that were not sent', () => {
    const created = upsertCalendarEntry(fixture.db, {
      intended_date: '2026-09-03',
      note: 'draw on the audit-chain claim',
    });

    const moved = upsertCalendarEntry(fixture.db, { id: created.id, status: 'drafted' });

    expect(moved.status).toBe('drafted');
    // Not clearing the note: an update that sent only a status must not erase
    // the reason the entry exists.
    expect(moved.note).toBe('draw on the audit-chain claim');
    expect(moved.intended_date).toBe('2026-09-03');
  });

  it('refuses to file an entry against a draft that does not exist', () => {
    expect(() =>
      upsertCalendarEntry(fixture.db, { intended_date: '2026-09-04', draft_id: 'drf_nope' }),
    ).toThrow();
  });
});

describe('reading a Shares export', () => {
  it('refuses a file that is not one, rather than importing nothing successfully', () => {
    const { artifactId } = seedRealArtifact(fixture, 'Name,Email\nAlex,alex@example.com\n', {
      relpath: 'Contacts.csv',
    });

    // "Imported 0 posts" from the wrong file reads as "you have never posted".
    expect(() => importPublishedPosts(fixture.db, fixture.store, artifactId)).toThrow(
      /does not look like a Shares export/i,
    );
  });

  it('skips a row with no commentary or no date', () => {
    const report = importShares(
      `${SHARES_HEADER}` +
        '2025-11-02 10:15:00,,On zip bombs and why the importer refuses them,,,PUBLIC\n' +
        '2025-12-14 08:00:00,,,,,PUBLIC\n' +
        ',,A post with no date at all,,,PUBLIC\n',
    );

    // A row without both is not a post; counting it would inflate the history
    // every voice-profile number is derived from.
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(2);
  });

  it('skips a post it already has, so re-importing an export is safe', () => {
    const csv =
      `${SHARES_HEADER}` +
      '2025-11-02 10:15:00,,On zip bombs and why the importer refuses them,,,PUBLIC\n';
    expect(importShares(csv).imported).toBe(1);

    const again = importShares(csv);

    // Members re-download the same export. Duplicating would double every count
    // in the voice profile.
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    expect(listPublishedPosts(fixture.db)).toHaveLength(1);
  });

  it('builds a voice profile from what it read', () => {
    importShares(
      `${SHARES_HEADER}` +
        '2025-11-02 10:15:00,https://www.linkedin.com/feed/update/urn:li:share:1,' +
        'On zip bombs and why the importer refuses them #security,https://example.com/zip,,PUBLIC\n' +
        '2025-12-14 08:00:00,,A note on hash-chained audit logs #security #tooling,,,PUBLIC\n',
    );

    const profile = voiceProfile(fixture.db);

    expect(profile.top_hashtags.find((h) => h.tag === '#security')?.count).toBe(2);
    // The shared link is counted separately from the post's own permalink,
    // because "you link out in half your posts" is advice and "you have posted
    // twice" is not.
    expect(profile.posts_with_link).toBe(1);
  });
});

describe('telling one alphabet from another', () => {
  it('recognises Cyrillic, and does not see it in Latin text', () => {
    // The member's own language mix is evidence about their voice; guessing it
    // from a script that is not there would put the wrong advice in front of
    // them.
    expect(containsCyrillic('Пример текста')).toBe(true);
    expect(containsCyrillic('A note on deterministic parsing')).toBe(false);
    expect(containsCyrillic('')).toBe(false);
  });
});

describe('the seeded corpus', () => {
  it('still reads back after all of this', () => {
    expect(seeded.candidateId).toMatch(/^clm_/);
  });
});
