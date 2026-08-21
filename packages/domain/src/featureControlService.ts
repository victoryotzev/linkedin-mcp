import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import { appendAuditEvent, type AuditActor } from './auditService.ts';

export const FEATURE_KEYS = [
  'evidence',
  'profile',
  'content',
  'publication_workflow',
  'analytics',
  'linkedin_sync',
  'maintenance',
  'configuration',
  'live_publishing',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureControl {
  key: FeatureKey;
  title: string;
  description: string;
  enabled: boolean;
  default_enabled: boolean;
}

const STORAGE_KEY = 'features.enabled';

const DEFINITIONS: Record<FeatureKey, Omit<FeatureControl, 'key' | 'enabled'>> = {
  evidence: {
    title: 'Evidence and claims',
    description:
      'Sources, imports, artifacts, claim verification, rejection, ambiguity, merging, conflicts, and coverage.',
    default_enabled: true,
  },
  profile: {
    title: 'Profile and change sets',
    description:
      'Canonical profile revisions, LinkedIn snapshots, diffs, scoring, reviewable patches, and application tracking.',
    default_enabled: true,
  },
  content: {
    title: 'Drafting and content planning',
    description:
      'Post drafts, deterministic validation, published history, voice analysis, opportunities, pillars, and calendar.',
    default_enabled: true,
  },
  publication_workflow: {
    title: 'Publication workflow',
    description:
      'Approval requests and decisions, dry-run publishing, publication history, reconciliation, and audit inspection.',
    default_enabled: true,
  },
  analytics: {
    title: 'Analytics',
    description:
      'Manual observation import, summaries, and explicitly caveated cohort comparisons.',
    default_enabled: true,
  },
  linkedin_sync: {
    title: 'LinkedIn API synchronization',
    description:
      'Capability verification and member-owned LinkedIn Data Portability snapshot/changelog synchronization.',
    default_enabled: true,
  },
  maintenance: {
    title: 'Maintenance and data lifecycle',
    description:
      'Backups, verification, exports, retention, artifact purge, and explicitly confirmed full local purge.',
    default_enabled: true,
  },
  configuration: {
    title: 'Non-secret configuration',
    description:
      'Typed runtime settings and feature controls. Credentials are intentionally excluded and use the dashboard or CLI.',
    default_enabled: true,
  },
  live_publishing: {
    title: 'Live LinkedIn account publishing',
    description:
      'Send an approved text post to the real LinkedIn account. Disabled by default and still requires a verified write credential plus an exact publish command.',
    default_enabled: false,
  },
};

function overrides(db: SqliteDriver): Partial<Record<FeatureKey, boolean>> {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', STORAGE_KEY);
  if (!row) return {};
  try {
    const value = JSON.parse(String(row['value_json'])) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    const parsed: Partial<Record<FeatureKey, boolean>> = {};
    for (const key of FEATURE_KEYS) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'boolean') parsed[key] = candidate;
    }
    return parsed;
  } catch {
    // Falling back to defaults would silently re-enable deliberately disabled
    // groups after database corruption. Policy state fails closed instead.
    throw new DomainError(
      'INTEGRITY_ERROR',
      'shared feature settings are unreadable; restore the database from a verified backup',
      { blockers: ['feature_settings_corrupt'] },
    );
  }
}

export function listFeatureControls(db: SqliteDriver): FeatureControl[] {
  const stored = overrides(db);
  return FEATURE_KEYS.map((key) => ({
    key,
    ...DEFINITIONS[key],
    enabled: stored[key] ?? DEFINITIONS[key].default_enabled,
  }));
}

export function getFeatureControl(db: SqliteDriver, key: FeatureKey): FeatureControl {
  return listFeatureControls(db).find((feature) => feature.key === key)!;
}

export function requireFeatureEnabled(db: SqliteDriver, key: FeatureKey): void {
  const feature = getFeatureControl(db, key);
  if (!feature.enabled) {
    throw new DomainError(
      'CAPABILITY_UNAVAILABLE',
      `${feature.title} is disabled in shared feature settings. Re-enable '${key}' through MCP, the dashboard, or npm run control.`,
      { blockers: [`feature_disabled:${key}`] },
    );
  }
}

export function setFeatureControl(
  db: SqliteDriver,
  key: FeatureKey,
  enabled: boolean,
  input: { confirm: boolean; actor: AuditActor },
): FeatureControl {
  if (!input.confirm) {
    throw new DomainError('INVALID_INPUT', `changing feature '${key}' requires confirm=true`, {
      blockers: ['confirmation_required'],
    });
  }
  return withWriteTx(db, () => {
    const before = getFeatureControl(db, key);
    if (before.enabled === enabled) return before;
    const current = overrides(db);
    current[key] = enabled;
    db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      STORAGE_KEY,
      JSON.stringify(current),
      new Date().toISOString(),
    );
    appendAuditEvent(db, {
      event_type: enabled ? 'feature.enabled' : 'feature.disabled',
      actor: input.actor,
      subject_type: 'feature',
      subject_id: key,
      payload: { enabled },
    });
    return getFeatureControl(db, key);
  });
}
