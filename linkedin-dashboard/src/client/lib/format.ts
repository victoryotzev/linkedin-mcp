// Presentation of machine facts.
//
// The old dashboard printed raw ISO timestamps, full 26-character ULIDs and
// `JSON.stringify(location)` straight into the page. None of that is wrong,
// exactly — it is just unreadable, and it pushed the actual content off the
// line. These helpers keep the full value available (title attribute, copy
// button) while showing something a person can scan.

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const ABSOLUTE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const delta = then - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : ABSOLUTE.format(date);
}

/** Prefix plus eight characters. The full value stays in the title and the clipboard. */
export function shortId(id: string): string {
  const underscore = id.indexOf('_');
  if (underscore === -1) return id.length > 12 ? `${id.slice(0, 12)}…` : id;
  const prefix = id.slice(0, underscore + 1);
  const rest = id.slice(underscore + 1);
  return rest.length > 8 ? `${prefix}${rest.slice(0, 8)}…` : id;
}

export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** Middle-truncation, because both ends of a path carry meaning. */
export function middleTruncate(value: string, max = 48): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
