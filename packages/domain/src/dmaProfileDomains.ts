import { createHash } from 'node:crypto';
import { canonicalJson, DomainError, type Jsonish } from '@linkedin-mcp/shared';

// Member Snapshot domains that describe the profile, and how each one becomes a
// stable rendering plus a stable fingerprint.
//
// Two things about the Snapshot API shape the whole file. First, LinkedIn says
// data "for certain domains will be available sooner than others, depending on
// the effort required by LinkedIn to collate this data" — so a domain answering
// with nothing is a state of its own, never proof the member has no entries.
// Second, the response carries no generation timestamp and no completeness
// marker, so the only thing that can be compared between two reads is content.
// Hence a fingerprint per domain and one across the read.
//
// Every domain here has its own renderer. The previous implementation fell
// through to the SKILLS renderer for everything it did not name explicitly,
// which silently turned certifications, courses, honors, languages, projects,
// publications and articles into comma-joined name lists.

export const PROFILE_SNAPSHOT_DOMAINS = [
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
] as const;
export type ProfileSnapshotDomain = (typeof PROFILE_SNAPSHOT_DOMAINS)[number];

/**
 * Own content and post history. Allowlisted and durable under the portability
 * terms, but they are not profile sections and are never rendered as one.
 */
export const CONTENT_SNAPSHOT_DOMAINS = ['MEMBER_SHARE_INFO', 'ARTICLES'] as const;

/**
 * What `linkedin_dma_sync` fetches when the caller names no domains: every
 * profile domain plus own post history. Pinned by a test so widening it is
 * always a deliberate act — each domain is a separate paginated walk against
 * LinkedIn, so this list is also the latency and rate-limit budget.
 */
export const DEFAULT_SNAPSHOT_DOMAINS = [...PROFILE_SNAPSHOT_DOMAINS, 'MEMBER_SHARE_INFO'] as const;

export function isProfileSnapshotDomain(domain: string): domain is ProfileSnapshotDomain {
  return (PROFILE_SNAPSHOT_DOMAINS as readonly string[]).includes(domain);
}

/**
 * What one requested domain did on one read.
 *
 * `empty_or_not_ready` is deliberately one status and not two: LinkedIn's
 * page-zero "No data found" answer is identical whether the member has no
 * entries or the domain has not been collated yet, and this product does not
 * get to pick which.
 */
export type DomainObservationStatus =
  | 'populated'
  | 'empty_or_not_ready'
  | 'failed'
  | 'pagination_incomplete';

export type SnapshotRow = Record<string, unknown>;

export interface DomainObservation {
  domain: string;
  status: DomainObservationStatus;
  rows: SnapshotRow[];
  row_count: number;
  /**
   * sha256 over the canonical JSON of the rows LinkedIn returned. An empty
   * answer still gets one — the hash of `[]` — because "answered with nothing"
   * is content that can be compared. Only a failed or truncated read has no
   * fingerprint, and null is what distinguishes those from an empty domain.
   */
  fingerprint: string | null;
  failure_reason?: string;
}

export interface RenderedField {
  key: string;
  text: string;
}

// ---- locale --------------------------------------------------------------

/** `en_US`, `bg_BG`, … as LinkedIn writes them in localized string maps. */
export type LocaleTag = string;

function localeLanguage(tag: string): string {
  return tag.slice(0, 2).toLowerCase();
}

/**
 * Resolves one value that may be a plain string or one of LinkedIn's localized
 * string objects — `{ localized: { en_US: "…" }, preferredLocale: { country, language } }`.
 *
 * Order: the caller's preference, then the locale the payload itself declares
 * preferred, then any entry sharing the caller's language, then the
 * lexicographically first key. The last step is what makes this deterministic:
 * there is no implicit en_US, so a member whose profile is only in Bulgarian
 * gets their own text rather than an empty string.
 */
export function pickLocalized(value: unknown, preferred?: LocaleTag): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const localized = record['localized'];
  if (typeof localized !== 'object' || localized === null || Array.isArray(localized)) {
    return null;
  }
  const entries = Object.entries(localized as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );
  if (entries.length === 0) return null;

  const byTag = new Map(entries);
  if (preferred !== undefined && byTag.has(preferred)) return byTag.get(preferred)!;

  const payloadPreferred = record['preferredLocale'];
  if (
    typeof payloadPreferred === 'object' &&
    payloadPreferred !== null &&
    !Array.isArray(payloadPreferred)
  ) {
    const pref = payloadPreferred as Record<string, unknown>;
    const language = pref['language'];
    const country = pref['country'];
    if (typeof language === 'string' && typeof country === 'string') {
      const tag = `${language}_${country}`;
      if (byTag.has(tag)) return byTag.get(tag)!;
    }
  }

  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (preferred !== undefined) {
    const language = localeLanguage(preferred);
    const sameLanguage = sorted.find(([tag]) => localeLanguage(tag) === language);
    if (sameLanguage) return sameLanguage[1];
  }
  return sorted[0]![1];
}

// ---- row helpers ---------------------------------------------------------

/**
 * First non-empty value among the candidate column names.
 *
 * Snapshot columns are the human-readable export headers ("Company Name"), but
 * the API has shipped camelCase for some domains, so both spellings are tried.
 * Values are run through the localized-string resolver on the way out.
 */
function pick(row: SnapshotRow, locale: LocaleTag | undefined, ...names: string[]): string {
  for (const name of names) {
    const resolved = pickLocalized(row[name], locale);
    if (resolved !== null && resolved.trim().length > 0) return resolved.trim();
  }
  return '';
}

/**
 * Last-resort rendering for a row none of a domain's named columns matched.
 * Losing the row entirely would be worse: the point of this read path is that
 * what LinkedIn returned is what gets reported.
 */
function describeUnknownRow(row: SnapshotRow, locale: LocaleTag | undefined): string {
  return Object.keys(row)
    .sort()
    .map((key) => [key, pickLocalized(row[key], locale)] as const)
    .filter((entry): entry is readonly [string, string] => (entry[1] ?? '').trim().length > 0)
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join('; ');
}

function joinRows(
  rows: SnapshotRow[],
  locale: LocaleTag | undefined,
  toLine: (row: SnapshotRow, locale: LocaleTag | undefined) => string,
  separator: string,
): string {
  return rows
    .map((row) => toLine(row, locale) || describeUnknownRow(row, locale))
    .filter((line) => line.length > 0)
    .join(separator);
}

function lines(
  rows: SnapshotRow[],
  locale: LocaleTag | undefined,
  toLine: (row: SnapshotRow, locale: LocaleTag | undefined) => string,
): string {
  return joinRows(rows, locale, toLine, '\n');
}

function dateRange(start: string, end: string): string {
  return `${start || '?'} – ${end || 'present'}`;
}

function suffix(label: string, value: string): string {
  return value ? `${label}${value}` : '';
}

// ---- renderers -----------------------------------------------------------

export interface ProfileDomainRenderer {
  /** Every snapshot field key this domain may write. */
  readonly fieldKeys: readonly string[];
  render(rows: SnapshotRow[], locale?: LocaleTag): RenderedField[];
}

// PROFILE is the one domain that fans out into several scalar fields; the rest
// render to a single multi-line field keyed like the canonical section.
const PROFILE_COLUMNS = [
  ['headline', ['Headline', 'headline']],
  ['about', ['Summary', 'summary', 'About', 'about']],
  ['industry', ['Industry', 'industry']],
  ['geo_location', ['Geo Location', 'geoLocation', 'Location', 'location']],
  ['websites', ['Websites', 'websites']],
  ['first_name', ['First Name', 'firstName']],
  ['last_name', ['Last Name', 'lastName']],
] as const;

const RENDERERS = {
  PROFILE: {
    fieldKeys: PROFILE_COLUMNS.map(([key]) => key),
    render(rows, locale) {
      // LinkedIn documents PROFILE as one row per member. Any further row is
      // ignored rather than merged — merging two profiles field by field would
      // invent a person who does not exist.
      const row = rows[0] ?? {};
      const fields: RenderedField[] = [];
      for (const [key, names] of PROFILE_COLUMNS) {
        const value = pick(row, locale, ...names);
        if (value) fields.push({ key, text: value });
      }
      return fields;
    },
  },

  POSITIONS: {
    fieldKeys: ['experience'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const title = pick(row, loc, 'Title', 'title');
        const company = pick(row, loc, 'Company Name', 'companyName', 'Company', 'company');
        const location = pick(row, loc, 'Location', 'location');
        const description = pick(row, loc, 'Description', 'description');
        if (!title && !company) return '';
        const range = dateRange(
          pick(row, loc, 'Started On', 'startedOn'),
          pick(row, loc, 'Finished On', 'finishedOn'),
        );
        return (
          `${title}${suffix(' — ', company)} (${range})` +
          suffix(' · ', location) +
          suffix(': ', description)
        );
      });
      return text ? [{ key: 'experience', text }] : [];
    },
  },

  EDUCATION: {
    fieldKeys: ['education'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const school = pick(row, loc, 'School Name', 'schoolName', 'School', 'school');
        if (!school) return '';
        const degree = pick(row, loc, 'Degree Name', 'degreeName', 'Degree', 'degree');
        const range = dateRange(
          pick(row, loc, 'Start Date', 'startDate', 'Started On'),
          pick(row, loc, 'End Date', 'endDate', 'Finished On'),
        );
        const activities = pick(row, loc, 'Activities', 'activities');
        return `${school}${suffix(' — ', degree)} (${range})` + suffix(' · ', activities);
      });
      return text ? [{ key: 'education', text }] : [];
    },
  },

  SKILLS: {
    fieldKeys: ['skills'],
    render(rows, locale) {
      // Comma-joined rather than one per line, but it goes through the same
      // unknown-row fallback as every other domain. It used to drop a row whose
      // columns it did not recognise, which is how a renamed column silently
      // emptied the member's skills.
      const text = joinRows(
        rows,
        locale,
        (row, loc) => pick(row, loc, 'Name', 'name', 'Skill Name', 'skillName'),
        ', ',
      );
      return text ? [{ key: 'skills', text }] : [];
    },
  },

  CERTIFICATIONS: {
    fieldKeys: ['certifications'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const name = pick(row, loc, 'Name', 'name');
        if (!name) return '';
        const authority = pick(row, loc, 'Authority', 'authority', 'Issuer', 'issuer');
        const range = dateRange(
          pick(row, loc, 'Started On', 'startedOn', 'Issued On', 'issuedOn'),
          pick(row, loc, 'Finished On', 'finishedOn', 'Expires On', 'expiresOn'),
        );
        const license = pick(row, loc, 'License Number', 'licenseNumber');
        return `${name}${suffix(' — ', authority)} (${range})` + suffix(' · #', license);
      });
      return text ? [{ key: 'certifications', text }] : [];
    },
  },

  COURSES: {
    fieldKeys: ['courses'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const name = pick(row, loc, 'Name', 'name', 'Title', 'title');
        if (!name) return '';
        return `${name}${suffix(' · ', pick(row, loc, 'Number', 'number'))}`;
      });
      return text ? [{ key: 'courses', text }] : [];
    },
  },

  HONORS: {
    fieldKeys: ['honors'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const title = pick(row, loc, 'Title', 'title', 'Name', 'name');
        if (!title) return '';
        const issuer = pick(row, loc, 'Issuer', 'issuer', 'Authority', 'authority');
        const issued = pick(row, loc, 'Issued On', 'issuedOn', 'Date', 'date');
        const description = pick(row, loc, 'Description', 'description');
        return (
          `${title}${suffix(' — ', issuer)}${suffix(' (', issued)}${issued ? ')' : ''}` +
          suffix(': ', description)
        );
      });
      return text ? [{ key: 'honors', text }] : [];
    },
  },

  LANGUAGES: {
    fieldKeys: ['languages'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const name = pick(row, loc, 'Name', 'name', 'Language', 'language');
        if (!name) return '';
        const proficiency = pick(row, loc, 'Proficiency', 'proficiency');
        return `${name}${suffix(' — ', proficiency)}`;
      });
      return text ? [{ key: 'languages', text }] : [];
    },
  },

  PROJECTS: {
    fieldKeys: ['projects'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const title = pick(row, loc, 'Title', 'title', 'Name', 'name');
        if (!title) return '';
        const range = dateRange(
          pick(row, loc, 'Started On', 'startedOn'),
          pick(row, loc, 'Finished On', 'finishedOn'),
        );
        const url = pick(row, loc, 'Url', 'url', 'URL');
        const description = pick(row, loc, 'Description', 'description');
        return `${title} (${range})` + suffix(' · ', url) + suffix(': ', description);
      });
      return text ? [{ key: 'projects', text }] : [];
    },
  },

  PUBLICATIONS: {
    fieldKeys: ['publications'],
    render(rows, locale) {
      const text = lines(rows, locale, (row, loc) => {
        const name = pick(row, loc, 'Name', 'name', 'Title', 'title');
        if (!name) return '';
        const publisher = pick(row, loc, 'Publisher', 'publisher');
        const published = pick(row, loc, 'Published On', 'publishedOn', 'Date', 'date');
        const url = pick(row, loc, 'Url', 'url', 'URL');
        const description = pick(row, loc, 'Description', 'description');
        return (
          `${name}${suffix(' — ', publisher)}${suffix(' (', published)}${published ? ')' : ''}` +
          suffix(' · ', url) +
          suffix(': ', description)
        );
      });
      return text ? [{ key: 'publications', text }] : [];
    },
  },
  // A missing renderer is a compile error, not a silent fallthrough.
} satisfies Record<ProfileSnapshotDomain, ProfileDomainRenderer>;

export function fieldKeysForDomain(domain: ProfileSnapshotDomain): readonly string[] {
  return RENDERERS[domain].fieldKeys;
}

export function renderProfileDomain(
  domain: ProfileSnapshotDomain,
  rows: SnapshotRow[],
  locale?: LocaleTag,
): RenderedField[] {
  return RENDERERS[domain].render(rows, locale);
}

// ---- fingerprints --------------------------------------------------------

/**
 * Content identity for one domain's rows. Row order is preserved because it is
 * meaningful (LinkedIn returns positions newest-first) and because reordering
 * would make two genuinely different responses hash alike.
 */
export function fingerprintRows(rows: SnapshotRow[]): string {
  return createHash('sha256')
    .update(canonicalJson(rows as Jsonish), 'utf8')
    .digest('hex');
}

/**
 * Content identity for a whole read.
 *
 * Only domains LinkedIn actually answered take part. A domain that failed or
 * ran past the pagination cap is excluded and reported separately, so a
 * transient failure neither hides a real content change nor invents one — which
 * matters because "same fingerprint as last time" is half of the lag test.
 */
export function fingerprintObservation(observations: readonly DomainObservation[]): string {
  const answered = observations
    .filter((o) => o.status === 'populated' || o.status === 'empty_or_not_ready')
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
    .map((o) => [o.domain, { status: o.status, fingerprint: o.fingerprint }] as const);
  return createHash('sha256')
    .update(canonicalJson(Object.fromEntries(answered) as Jsonish), 'utf8')
    .digest('hex');
}

// ---- failure classification ---------------------------------------------

/**
 * A walk that hits the client's page cap is not the same as a domain that
 * failed: rows were returned, we just cannot prove they are all of them. The
 * client still throws rather than handing back a partial page (that safety
 * behaviour is unchanged); this only reads which kind of failure it was.
 */
export function classifyFetchFailure(err: unknown): {
  status: Extract<DomainObservationStatus, 'failed' | 'pagination_incomplete'>;
  reason: string;
} {
  const reason = err instanceof Error ? err.message : String(err);
  if (err instanceof DomainError && err.blockers.includes('snapshot_page_cap')) {
    return { status: 'pagination_incomplete', reason };
  }
  return { status: 'failed', reason };
}

export function observeRows(domain: string, rows: SnapshotRow[]): DomainObservation {
  return {
    domain,
    status: rows.length > 0 ? 'populated' : 'empty_or_not_ready',
    rows,
    row_count: rows.length,
    fingerprint: fingerprintRows(rows),
  };
}

export function observeFailure(domain: string, err: unknown): DomainObservation {
  const { status, reason } = classifyFetchFailure(err);
  return { domain, status, rows: [], row_count: 0, fingerprint: null, failure_reason: reason };
}
