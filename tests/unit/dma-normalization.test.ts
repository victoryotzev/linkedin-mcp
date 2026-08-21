import { describe, expect, it } from 'vitest';
import {
  CONTENT_SNAPSHOT_DOMAINS,
  DEFAULT_SNAPSHOT_DOMAINS,
  PROFILE_SNAPSHOT_DOMAINS,
  classifyFetchFailure,
  fieldKeysForDomain,
  fingerprintObservation,
  fingerprintRows,
  isProfileSnapshotDomain,
  isValidEventTimestamp,
  newestValidProcessedAt,
  normalizeChangelogElement,
  observeFailure,
  observeRows,
  pickLocalized,
  renderProfileDomain,
  type DomainObservation,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';

const NOW = Date.parse('2026-08-12T10:00:00.000Z');

describe('snapshot domain coverage', () => {
  // The defect this replaces: persistSync named PROFILE/POSITIONS/EDUCATION/
  // SKILLS and fell through to the SKILLS renderer for everything else, so
  // certifications, courses, honors, languages, projects and publications were
  // silently rendered as comma-joined name lists.
  it('every profile domain renders through its own renderer', () => {
    for (const domain of PROFILE_SNAPSHOT_DOMAINS) {
      const keys = fieldKeysForDomain(domain);
      expect(keys.length).toBeGreaterThan(0);
      expect(() => renderProfileDomain(domain, [])).not.toThrow();
    }
    // No two non-PROFILE domains may claim the same field key.
    const singleKeyDomains = PROFILE_SNAPSHOT_DOMAINS.filter((d) => d !== 'PROFILE');
    const keys = singleKeyDomains.flatMap((d) => [...fieldKeysForDomain(d)]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('renders each domain from its own columns rather than a name list', () => {
    const cases: Array<
      [(typeof PROFILE_SNAPSHOT_DOMAINS)[number], Record<string, unknown>, string]
    > = [
      [
        'CERTIFICATIONS',
        { Name: 'AWS SAA', Authority: 'Amazon', 'Started On': 'Jan 2024' },
        'AWS SAA — Amazon (Jan 2024 – present)',
      ],
      [
        'LANGUAGES',
        { Name: 'Dutch', Proficiency: 'Native or bilingual' },
        'Dutch — Native or bilingual',
      ],
      [
        'COURSES',
        { Name: 'Distributed Systems', Number: 'CS-4400' },
        'Distributed Systems · CS-4400',
      ],
      [
        'PUBLICATIONS',
        { Name: 'On Renovation', Publisher: 'ACM', 'Published On': '2025' },
        'On Renovation — ACM (2025)',
      ],
      [
        'PROJECTS',
        { Title: 'Evidence Ledger', 'Started On': '2026', Url: 'https://example.test' },
        'Evidence Ledger (2026 – present) · https://example.test',
      ],
      [
        'HONORS',
        { Title: 'Best Paper', Issuer: 'ACM', 'Issued On': '2025' },
        'Best Paper — ACM (2025)',
      ],
    ];
    for (const [domain, row, expected] of cases) {
      const [field] = renderProfileDomain(domain, [row]);
      expect(field?.text, domain).toBe(expected);
    }
  });

  it('keeps a row whose columns it does not recognise instead of dropping it', () => {
    // SKILLS is included deliberately: it joins with ', ' rather than newlines
    // and used to bypass the unknown-row fallback entirely, so a renamed column
    // silently emptied the member's skills.
    for (const domain of PROFILE_SNAPSHOT_DOMAINS) {
      if (domain === 'PROFILE') continue; // fans out into named scalars, not rows
      const [field] = renderProfileDomain(domain, [{ Weird: 'value', Other: 'thing' }]);
      expect(field?.text, domain).toBe('Other: thing; Weird: value');
    }
  });

  it('pins the default domain set, because it is also the latency budget', () => {
    expect([...DEFAULT_SNAPSHOT_DOMAINS]).toEqual([
      'PROFILE',
      'POSITIONS',
      'EDUCATION',
      'SKILLS',
      'CERTIFICATIONS',
      'COURSES',
      'HONORS',
      'LANGUAGES',
      'PROJECTS',
      'PUBLICATIONS',
      'MEMBER_SHARE_INFO',
    ]);
    // Content/history domains are not profile sections.
    for (const domain of CONTENT_SNAPSHOT_DOMAINS) {
      expect(isProfileSnapshotDomain(domain)).toBe(false);
    }
    expect(isProfileSnapshotDomain('ARTICLES')).toBe(false);
  });
});

describe('locale selection', () => {
  const localized = {
    localized: { bg_BG: 'Уеб разработчик', en_US: 'Web Developer', de_DE: 'Webentwickler' },
    preferredLocale: { country: 'BG', language: 'bg' },
  };

  it('prefers the caller locale, then the payload locale, then a stable fallback', () => {
    expect(pickLocalized(localized, 'de_DE')).toBe('Webentwickler');
    // No caller preference: the payload says which locale it considers primary.
    expect(pickLocalized(localized)).toBe('Уеб разработчик');
    // Unknown caller locale, same language as nothing: lexicographically first,
    // which is deterministic and is NOT hardcoded en_US.
    expect(pickLocalized({ localized: { fr_FR: 'Développeur', ja_JP: '開発者' } }, 'pt_BR')).toBe(
      'Développeur',
    );
  });

  it('matches on language when the exact tag is absent', () => {
    expect(pickLocalized({ localized: { en_GB: 'Colour', zz_ZZ: 'x' } }, 'en_US')).toBe('Colour');
  });

  it('passes plain strings through and refuses shapes it cannot resolve', () => {
    expect(pickLocalized('plain')).toBe('plain');
    expect(pickLocalized({ localized: {} })).toBeNull();
    expect(pickLocalized(null)).toBeNull();
    expect(pickLocalized(42)).toBeNull();
  });

  it('resolves localized values inside snapshot rows', () => {
    const [field] = renderProfileDomain(
      'SKILLS',
      [{ Name: { localized: { bg_BG: 'Типове', en_US: 'Types' } } }],
      'bg_BG',
    );
    expect(field?.text).toBe('Типове');
  });
});

describe('fingerprints', () => {
  it('are stable for identical input and differ for changed input', () => {
    const rows = [{ Title: 'a' }, { Title: 'b' }];
    expect(fingerprintRows(rows)).toBe(fingerprintRows([{ Title: 'a' }, { Title: 'b' }]));
    expect(fingerprintRows(rows)).not.toBe(fingerprintRows([{ Title: 'b' }, { Title: 'a' }]));
    // Key order inside a row is not content.
    expect(fingerprintRows([{ a: 1, b: 2 }])).toBe(fingerprintRows([{ b: 2, a: 1 }]));
  });

  it('ignores failed domains so a transient failure neither hides nor invents a change', () => {
    const ok: DomainObservation = observeRows('PROFILE', [{ Headline: 'x' }]);
    const withFailure: DomainObservation[] = [ok, observeFailure('SKILLS', new Error('503'))];
    expect(fingerprintObservation([ok])).toBe(fingerprintObservation(withFailure));
    // But an answered-and-empty domain is content, and does change it.
    expect(fingerprintObservation([ok])).not.toBe(
      fingerprintObservation([ok, observeRows('SKILLS', [])]),
    );
  });
});

describe('domain status classification', () => {
  it('separates empty, failed and pagination-incomplete', () => {
    expect(observeRows('SKILLS', [{ Name: 'x' }]).status).toBe('populated');
    expect(observeRows('SKILLS', []).status).toBe('empty_or_not_ready');
    expect(observeFailure('SKILLS', new Error('boom')).status).toBe('failed');
    const capped = new DomainError('INTERNAL', 'did not terminate within 200 pages', {
      blockers: ['snapshot_page_cap'],
    });
    expect(classifyFetchFailure(capped).status).toBe('pagination_incomplete');
    expect(observeFailure('POSITIONS', capped).status).toBe('pagination_incomplete');
  });
});

describe('changelog element normalization', () => {
  it('projects documented fields and refuses to coerce the rest', () => {
    const normalized = normalizeChangelogElement(
      {
        id: 978988628,
        activityId: 'c86c3c71',
        resourceName: 'people/positions',
        resourceId: 4,
        method: 'PARTIAL_UPDATE',
        configVersion: 2,
        activityStatus: 'SUCCESSFUL_REPLAY',
        capturedAt: NOW - 1000,
        processedAt: NOW - 500,
      },
      NOW,
    );
    expect(normalized).toEqual({
      upstream_event_id: '978988628',
      activity_id: 'c86c3c71',
      resource_name: 'people/positions',
      resource_id: '4',
      method: 'PARTIAL_UPDATE',
      config_version: 2,
      activity_status: 'SUCCESSFUL_REPLAY',
      captured_at_ms: NOW - 1000,
      processed_at_ms: NOW - 500,
    });
  });

  it('nulls a timestamp it cannot trust rather than guessing one', () => {
    expect(isValidEventTimestamp(NOW - 1, NOW)).toBe(true);
    expect(isValidEventTimestamp(NOW + 4 * 60 * 1000, NOW)).toBe(true);
    expect(isValidEventTimestamp(NOW + 10 * 60 * 1000, NOW)).toBe(false);
    expect(isValidEventTimestamp(0, NOW)).toBe(false);
    expect(isValidEventTimestamp('123', NOW)).toBe(false);
    expect(isValidEventTimestamp(1.5, NOW)).toBe(false);

    const bad = normalizeChangelogElement({ processedAt: 32503680000000, id: {} }, NOW);
    expect(bad.processed_at_ms).toBeNull();
    expect(bad.upstream_event_id).toBeNull();
  });

  it('reports the newest usable processedAt in a batch', () => {
    expect(
      newestValidProcessedAt(
        [{ processedAt: NOW - 10 }, { processedAt: 32503680000000 }, { processedAt: NOW - 5 }],
        NOW,
      ),
    ).toBe(NOW - 5);
    expect(newestValidProcessedAt([{ id: 'x' }], NOW)).toBeNull();
    expect(newestValidProcessedAt([], NOW)).toBeNull();
  });
});
