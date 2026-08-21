import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { CAPABILITY_FEATURES, DomainError, type CapabilityFeature } from '@linkedin-mcp/shared';

export const CAPABILITY_STATUSES = [
  'unavailable',
  'configured',
  'verified',
  'expired',
  'revoked',
  'disabled',
  'blocked',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface Capability {
  feature: CapabilityFeature;
  status: CapabilityStatus;
  blockers: string[];
  api_version: string | null;
  verified_at: string | null;
  notes: string | null;
  remediation: string;
}

const REMEDIATION: Record<CapabilityStatus, string> = {
  unavailable:
    'Create a LinkedIn developer app, mint an access token via the Developer Portal Token Generator, store it through the dashboard or control CLI, then run capability verification. The rest of the product works without it.',
  configured:
    'A token is configured but unverified. Run capability verification through MCP, the dashboard, or control CLI before any external call is allowed.',
  verified: 'Capability is live. External calls are permitted for this feature.',
  expired:
    'The access token expired (~60-day LinkedIn lifetime). Mint a fresh token via the Developer Portal Token Generator and re-verify in the dashboard.',
  revoked:
    'LinkedIn rejected the credential (401/403). Re-mint the token with the correct products/scopes and re-verify in the dashboard.',
  disabled:
    'Feature was explicitly disabled in shared settings. Re-enable it through MCP, the dashboard, or control CLI if intended.',
  blocked:
    'Feature is blocked by policy or a stale API version. Review the blocker list in the dashboard before proceeding.',
};

// v1 posture: every LinkedIn-facing capability exists in the registry and is
// 'unavailable' (blocker: no_linkedin_app). Nothing external can run until a
// human walks the dashboard enablement flow — there is no code path that
// defaults to allow.
export function seedCapabilities(db: SqliteDriver): void {
  withWriteTx(db, () => {
    for (const feature of CAPABILITY_FEATURES) {
      db.run(
        `INSERT INTO capabilities (feature, status, blockers_json, updated_at)
         VALUES (?, 'unavailable', ?, ?)
         ON CONFLICT (feature) DO NOTHING`,
        feature,
        JSON.stringify(['no_linkedin_app']),
        new Date().toISOString(),
      );
    }
  });
}

// Some blockers have a remedy the status alone cannot express, and sending the
// member to the generic one would be actively wrong — telling someone to
// re-verify a token that is already fine wastes their time and casts suspicion
// on a credential that works.
const BLOCKER_REMEDIATION: Record<string, string> = {
  snapshot_not_ready:
    'The token works: LinkedIn authenticated it and resolved your member id, then reported that it has no data for you yet. It only begins assembling your historical data at first consent, and nothing here can hurry that along. Press "Verify against LinkedIn" again later — the lane opens by itself once LinkedIn returns rows.',
};

function rowToCapability(row: Record<string, unknown>): Capability {
  const status = String(row['status']) as CapabilityStatus;
  const blockers = JSON.parse(String(row['blockers_json'])) as string[];
  return {
    feature: String(row['feature']) as CapabilityFeature,
    status,
    blockers,
    api_version: (row['api_version'] as string | null) ?? null,
    verified_at: (row['verified_at'] as string | null) ?? null,
    notes: (row['notes'] as string | null) ?? null,
    remediation:
      blockers.map((blocker) => BLOCKER_REMEDIATION[blocker]).find(Boolean) ?? REMEDIATION[status],
  };
}

export function listCapabilities(db: SqliteDriver, feature?: string): Capability[] {
  const rows = feature
    ? db.all('SELECT * FROM capabilities WHERE feature = ?', feature)
    : db.all('SELECT * FROM capabilities ORDER BY feature');
  return rows.map(rowToCapability);
}

// The fail-closed gate every external-effect code path calls first, inside its
// own transaction. Unknown feature keys fail exactly like unavailable ones —
// there is no default-allow branch.
export function requireCapability(db: SqliteDriver, feature: string): Capability {
  const rows = listCapabilities(db, feature);
  const cap = rows[0];
  if (!cap) {
    throw new DomainError(
      'CAPABILITY_UNAVAILABLE',
      `capability '${feature}' is not registered; external calls are refused`,
      { blockers: ['unknown_capability'] },
    );
  }
  if (cap.status !== 'verified') {
    throw new DomainError(
      'CAPABILITY_UNAVAILABLE',
      `capability '${feature}' is ${cap.status}: ${cap.remediation}`,
      { blockers: cap.blockers.length > 0 ? cap.blockers : [cap.status] },
    );
  }
  return cap;
}
