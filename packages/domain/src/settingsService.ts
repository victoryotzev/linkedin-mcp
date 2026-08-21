import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, type Jsonish } from '@linkedin-mcp/shared';

export const FIELD_LIMIT_KEYS = [
  'headline',
  'about',
  'experience',
  'education',
  'skills',
  'post',
] as const;

export type FieldLimitKey = (typeof FIELD_LIMIT_KEYS)[number];
export type FieldLimits = Partial<Record<FieldLimitKey, number>>;

export interface SettingValues {
  field_limits: FieldLimits;
  'dashboard.port': number;
  'importer.max_file_mb': number;
  'importer.pii_skiplist': string[];
  'linkedin.posts_api_version': string;
}

export type SettingKey = keyof SettingValues;
export type SettingValue = SettingValues[SettingKey];
export const DEFAULT_DASHBOARD_PORT = 4780;

// Non-secret configuration only. Secrets enter through the dashboard or masked
// human control CLI into the DPAPI store — never through MCP.
export const ALLOWED_SETTINGS: Record<SettingKey, string> = {
  field_limits:
    'LinkedIn field character limits used by patch/draft validation. UNVERIFIED first-party; confirmed against real snapshots.',
  'dashboard.port': 'Loopback port for the review dashboard (default 4780).',
  'importer.max_file_mb': 'Per-file size ceiling for imports (default 50).',
  'importer.pii_skiplist': 'Export-archive file names skipped by default (third-party PII).',
  'linkedin.posts_api_version':
    'LinkedIn-Version (YYYYMM) for the Posts API lane. Bumped by the user after reading the LinkedIn changelog; never hard-coded.',
};

const SECRET_SHAPED = /(token|secret|password|credential|api[_-]?key|bearer|auth)/i;
const POSTS_VERSION = /^20\d{2}(?:0[1-9]|1[0-2])$/;
const FIELD_LIMIT_SET = new Set<string>(FIELD_LIMIT_KEYS);

function invalid(key: string, detail: string): never {
  throw new DomainError('INVALID_INPUT', `invalid value for setting '${key}': ${detail}`);
}

export function parseSettingValue(key: string, value: unknown): SettingValue {
  switch (key) {
    case 'dashboard.port':
      if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
        return invalid(key, 'expected an integer in [1024, 65535]');
      }
      return value as number;
    case 'importer.max_file_mb':
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1024) {
        return invalid(key, 'expected an integer in [1, 1024]');
      }
      return value as number;
    case 'importer.pii_skiplist': {
      if (!Array.isArray(value) || value.length > 100) {
        return invalid(key, 'expected an array of at most 100 file basenames');
      }
      const names = value.map((entry) => {
        if (
          typeof entry !== 'string' ||
          entry.length === 0 ||
          entry.length > 255 ||
          entry === '.' ||
          entry === '..' ||
          entry.includes('/') ||
          entry.includes('\\') ||
          entry.includes('\0')
        ) {
          return invalid(key, 'every entry must be a non-empty safe file basename');
        }
        return entry;
      });
      return names;
    }
    case 'field_limits': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return invalid(key, 'expected an object of known LinkedIn field limits');
      }
      const limits: FieldLimits = {};
      for (const [field, limit] of Object.entries(value)) {
        if (!FIELD_LIMIT_SET.has(field)) {
          return invalid(key, `unknown field '${field}'`);
        }
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100_000) {
          return invalid(key, `field '${field}' must be an integer in [1, 100000]`);
        }
        limits[field as FieldLimitKey] = limit as number;
      }
      return limits;
    }
    case 'linkedin.posts_api_version':
      if (typeof value !== 'string' || !POSTS_VERSION.test(value)) {
        return invalid(key, 'expected YYYYMM with a valid month');
      }
      return value;
    default:
      return invalid(
        key,
        `unknown setting; allowed keys: ${Object.keys(ALLOWED_SETTINGS).join(', ')}`,
      );
  }
}

export function setSetting(
  db: SqliteDriver,
  key: string,
  value: Jsonish,
  opts: { confirm?: boolean } = {},
): void {
  if (SECRET_SHAPED.test(key)) {
    throw new DomainError(
      'SECRET_VIA_MCP_FORBIDDEN',
      `setting key '${key}' looks secret-shaped; secrets are pasted in the dashboard (Capabilities area) and stored DPAPI-encrypted, never set through MCP`,
    );
  }
  if (!Object.hasOwn(ALLOWED_SETTINGS, key)) {
    throw new DomainError(
      'INVALID_INPUT',
      `unknown setting '${key}'; allowed keys: ${Object.keys(ALLOWED_SETTINGS).join(', ')}`,
    );
  }
  if (opts.confirm !== true) {
    throw new DomainError(
      'INVALID_INPUT',
      `setting '${key}' changes runtime safety behavior; repeat with confirm=true`,
      { blockers: ['confirmation_required'] },
    );
  }
  const parsed = parseSettingValue(key, value);
  withWriteTx(db, () => {
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(parsed),
      new Date().toISOString(),
    );
  });
}

export function getSetting<K extends SettingKey>(
  db: SqliteDriver,
  key: K,
): SettingValues[K] | undefined {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', key);
  if (!row) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(String(row['value_json']));
  } catch {
    return invalid(key, 'stored JSON is unreadable');
  }
  return parseSettingValue(key, raw) as SettingValues[K];
}

export function getSettingOrDefault<K extends SettingKey>(
  db: SqliteDriver,
  key: K,
  fallback: SettingValues[K],
): SettingValues[K] {
  try {
    return getSetting(db, key) ?? fallback;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'INVALID_INPUT') return fallback;
    throw error;
  }
}

export function resolveDashboardPort(db: SqliteDriver): number {
  return getSettingOrDefault(db, 'dashboard.port', DEFAULT_DASHBOARD_PORT);
}
