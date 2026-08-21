import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { appendAuditEvent } from './auditService.ts';
import type { HumanActor } from './auditService.ts';
import type { AuditActor } from './auditService.ts';
import { listCapabilities } from './capabilityService.ts';

// Tokens enter through an explicit human surface: the dashboard paste form or
// the masked local control CLI. Both call configureLane() below. Tokens are
// stored encrypted, never returned by a read path, and never travel through an
// MCP tool — the settings tool refuses secret-shaped keys to preserve that
// boundary.
//
// LinkedIn forces the two lanes into separate developer applications, so each
// lane carries its own client id and its own token.

export type Lane = 'read' | 'write';

export interface SecretStorePort {
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  has(name: string): boolean;
  remove(name: string): Promise<void>;
}

export interface LaneAccount {
  id: string;
  lane: Lane;
  label: string;
  client_id: string | null;
  person_urn: string | null;
  status: string;
  token_expires_at: string | null;
  has_token: boolean;
}

const LANE_CAPABILITIES: Record<Lane, string[]> = {
  // App 1 is bound to the Data Portability default Company Page, which
  // permanently excludes Sign In with LinkedIn and Share on LinkedIn.
  read: ['linkedin.dma_snapshot', 'linkedin.dma_changelog'],
  write: ['linkedin.oidc_userinfo', 'linkedin.publish_post', 'linkedin.image_upload'],
};

export function tokenSecretName(lane: Lane): string {
  return `linkedin.access_token.${lane}`;
}

function laneAccountRow(db: SqliteDriver, lane: Lane): Record<string, unknown> | undefined {
  return db.get('SELECT * FROM linkedin_accounts WHERE lane = ? ORDER BY created_at', lane);
}

export async function configureLane(
  db: SqliteDriver,
  store: SecretStorePort,
  input: {
    lane: Lane;
    client_id: string;
    access_token: string;
    expires_in_seconds?: number;
    actor?: HumanActor;
  },
): Promise<LaneAccount> {
  const token = input.access_token.trim();
  if (token.length < 20) {
    throw new DomainError(
      'INVALID_INPUT',
      'that does not look like a LinkedIn access token; mint one with the Developer Portal OAuth Token Generator',
    );
  }
  if (!input.client_id.trim()) {
    throw new DomainError('INVALID_INPUT', 'client_id is required so the lane can be told apart');
  }

  const secretName = tokenSecretName(input.lane);
  await store.put(secretName, token);

  // Documented lifetimes disagree with the API's own samples, so the expiry
  // recorded here always comes from what the caller actually observed, never
  // from a constant.
  const expiresAt =
    input.expires_in_seconds && Number.isFinite(input.expires_in_seconds)
      ? new Date(Date.now() + input.expires_in_seconds * 1000).toISOString()
      : null;

  return withWriteTx(db, () => {
    const existing = laneAccountRow(db, input.lane);
    const id = existing ? String(existing['id']) : newId('acc');
    const now = new Date().toISOString();
    if (existing) {
      db.run(
        `UPDATE linkedin_accounts SET client_id = ?, token_secret_name = ?, token_expires_at = ?, status = 'unverified' WHERE id = ?`,
        input.client_id.trim(),
        secretName,
        expiresAt,
        id,
      );
    } else {
      db.run(
        `INSERT INTO linkedin_accounts (id, label, status, created_at, lane, client_id, token_secret_name, token_expires_at)
         VALUES (?, ?, 'unverified', ?, ?, ?, ?, ?)`,
        id,
        input.lane === 'read' ? 'LinkedIn data portability app' : 'LinkedIn publishing app',
        now,
        input.lane,
        input.client_id.trim(),
        secretName,
        expiresAt,
      );
    }

    // Configured is not verified: a token that exists still has to prove it
    // works before any lane is opened.
    for (const feature of LANE_CAPABILITIES[input.lane]) {
      db.run(
        `UPDATE capabilities SET status = 'configured', blockers_json = ?, updated_at = ? WHERE feature = ?`,
        JSON.stringify(['not_verified_yet']),
        now,
        feature,
      );
    }

    appendAuditEvent(db, {
      event_type: 'capability.token_configured',
      actor: input.actor ?? 'dashboard',
      subject_type: 'account',
      subject_id: id,
      // The token itself is never part of the audit payload.
      payload: { lane: input.lane, client_id: input.client_id.trim(), expires_at: expiresAt },
    });

    return laneAccount(db, input.lane);
  });
}

export function laneAccount(db: SqliteDriver, lane: Lane): LaneAccount {
  const row = laneAccountRow(db, lane);
  if (!row) {
    throw new DomainError('NOT_FOUND', `no ${lane} lane configured yet`, {
      blockers: ['no_linkedin_app'],
    });
  }
  return {
    id: String(row['id']),
    lane,
    label: String(row['label']),
    client_id: (row['client_id'] as string | null) ?? null,
    person_urn: (row['person_urn'] as string | null) ?? null,
    status: String(row['status']),
    token_expires_at: (row['token_expires_at'] as string | null) ?? null,
    has_token: Boolean(row['token_secret_name']),
  };
}

export function listLanes(db: SqliteDriver): LaneAccount[] {
  return (['read', 'write'] as Lane[])
    .map((lane) => {
      try {
        return laneAccount(db, lane);
      } catch {
        return null;
      }
    })
    .filter((account): account is LaneAccount => account !== null);
}

export async function laneToken(
  db: SqliteDriver,
  store: SecretStorePort,
  lane: Lane,
): Promise<string> {
  const account = laneAccount(db, lane);
  if (!account.has_token) {
    throw new DomainError('CAPABILITY_UNAVAILABLE', `no token stored for the ${lane} lane`, {
      blockers: ['no_token'],
    });
  }
  if (account.token_expires_at && new Date(account.token_expires_at).getTime() < Date.now()) {
    demoteLane(db, lane, 'expired', 'token_expired');
    throw new DomainError(
      'CAPABILITY_UNAVAILABLE',
      `the ${lane} lane token expired on ${account.token_expires_at}; mint a fresh one with the Developer Portal OAuth Token Generator and paste it in the dashboard`,
      { blockers: ['token_expired'] },
    );
  }
  const token = await store.get(tokenSecretName(lane));
  if (!token) {
    throw new DomainError('CAPABILITY_UNAVAILABLE', `the ${lane} lane token could not be read`, {
      blockers: ['no_token'],
    });
  }
  return token;
}

// A live probe is the only thing that flips a capability to verified. Callers
// pass the probe so the domain never constructs an HTTP client itself.
export async function verifyLane(
  db: SqliteDriver,
  store: SecretStorePort,
  lane: Lane,
  probe: (
    token: string,
  ) => Promise<
    | { ok: true; person_urn?: string; warnings?: string[] }
    | { ok: false; status: number; message: string; retryable?: boolean }
  >,
  // Defaults to MCP attribution for existing callers. Human surfaces pass their
  // actor explicitly so the audit record reflects where the action occurred.
  actor: 'mcp_host' | HumanActor = 'mcp_host',
): Promise<{ lane: Lane; verified: string[]; person_urn: string | null; warnings: string[] }> {
  const token = await laneToken(db, store, lane);
  const result = await probe(token);

  if (!result.ok) {
    // A transient transport failure is not evidence about the credential.
    // Demoting on one is destructive: demotion is what requireCapability reads,
    // so a dropped connection or a 429 used to close a working lane until a
    // human re-verified it by hand.
    if (result.retryable === true) {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        `verification could not complete (${result.message}); the lane is unchanged — try again`,
        { blockers: ['probe_unreachable'], retryable: true },
      );
    }
    // 401 means the credential died; 403 means the product or scope is absent.
    // They demote to different states because the remedies differ.
    const status =
      result.status === 401 ? 'expired' : result.status === 403 ? 'revoked' : 'blocked';
    const blocker =
      result.status === 401
        ? 'token_expired'
        : result.status === 403
          ? 'scope_missing'
          : 'probe_failed';
    demoteLane(db, lane, status, blocker);
    throw new DomainError(
      'CAPABILITY_UNAVAILABLE',
      `verification failed (HTTP ${result.status}): ${result.message}`,
      { blockers: [blocker] },
    );
  }

  const personUrn = result.person_urn ?? null;
  const warnings = result.warnings ?? [];
  return withWriteTx(db, () => {
    const now = new Date().toISOString();
    const account = laneAccount(db, lane);
    // The credential is proven either way — the probe reached LinkedIn and was
    // answered. Account status records that; capability status records the
    // separate question of whether the lane can actually deliver data.
    db.run(
      "UPDATE linkedin_accounts SET status = 'verified', person_urn = COALESCE(?, person_urn) WHERE id = ?",
      personUrn,
      account.id,
    );

    const verified: string[] = [];
    for (const feature of LANE_CAPABILITIES[lane]) {
      // A working token that returns nothing does not open a lane. Holding at
      // 'configured' keeps requireCapability fail-closed, so a sync cannot run
      // and quietly import zero rows as though that were the whole history.
      if (warnings.length > 0) {
        db.run(
          `UPDATE capabilities SET status = 'configured', blockers_json = ?, updated_at = ? WHERE feature = ?`,
          JSON.stringify(warnings),
          now,
          feature,
        );
        continue;
      }
      // Publishing stays shut behind a second, explicit human toggle even once
      // the credential is proven — proving the token works is not the same as
      // deciding to post.
      if (feature === 'linkedin.publish_post' || feature === 'linkedin.image_upload') {
        db.run(
          `UPDATE capabilities SET status = 'configured', blockers_json = ?, updated_at = ? WHERE feature = ?`,
          JSON.stringify(['awaiting_explicit_enable']),
          now,
          feature,
        );
        continue;
      }
      db.run(
        `UPDATE capabilities SET status = 'verified', blockers_json = '[]', verified_at = ?, api_version = ?, updated_at = ? WHERE feature = ?`,
        now,
        feature.startsWith('linkedin.dma') ? '202312' : null,
        now,
        feature,
      );
      verified.push(feature);
    }

    appendAuditEvent(db, {
      // Recorded from the caller, not assumed. verifyLane is reachable both
      // from the dashboard and from the linkedin_capability_verify MCP tool, so
      // hard-coding 'dashboard' wrote a model-initiated promotion into the
      // hash-chained log as a human action — the log's whole job is to say who
      // did what.
      event_type: 'capability.verified',
      actor,
      subject_type: 'account',
      subject_id: account.id,
      payload: { lane, verified, person_urn: personUrn, warnings },
    });
    return { lane, verified, person_urn: personUrn, warnings };
  });
}

// The deliberate second gate for publishing.
export function enablePublishing(
  db: SqliteDriver,
  confirm: boolean,
  actor: AuditActor = 'dashboard',
): { status: string } {
  if (!confirm) {
    throw new DomainError(
      'INVALID_INPUT',
      'enabling publishing is a separate, explicit decision: pass confirm true',
    );
  }
  return withWriteTx(db, () => {
    const capability = listCapabilities(db, 'linkedin.publish_post')[0];
    if (capability?.status === 'verified' && capability.blockers.length === 0) {
      if (laneAccount(db, 'write').status !== 'verified') {
        throw new DomainError(
          'INTEGRITY_ERROR',
          'publishing is marked verified but the write lane account is not verified',
          { blockers: ['lane_capability_mismatch'] },
        );
      }
      return { status: 'verified' };
    }
    // 'configured' alone proves nothing: configureLane sets exactly that status
    // the moment a token STRING is pasted, before anything has been sent to
    // LinkedIn. Gating on it let a never-probed credential be promoted straight
    // to 'verified', which is the one thing the fail-closed capability model
    // exists to prevent. Only verifyLane writes the awaiting_explicit_enable
    // blocker, and only after a live probe came back ok.
    const reEnabling =
      capability?.status === 'disabled' && capability.blockers.includes('explicitly_disabled');
    if (!capability || (capability.status !== 'configured' && !reEnabling)) {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        'verify the publishing lane first; only a proven credential can be enabled',
        { blockers: [capability?.status ?? 'unknown'] },
      );
    }
    if (!capability.blockers.includes('awaiting_explicit_enable') && !reEnabling) {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        'the publishing token has been stored but never proved against LinkedIn; run verification on the write lane first',
        { blockers: capability.blockers.length > 0 ? capability.blockers : ['not_verified_yet'] },
      );
    }
    if (laneAccount(db, 'write').status !== 'verified') {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        'the write lane account is not verified; publishing cannot be enabled on an unproven account',
        { blockers: ['lane_not_verified'] },
      );
    }
    const now = new Date().toISOString();
    db.run(
      `UPDATE capabilities SET status = 'verified', blockers_json = '[]', verified_at = ?, updated_at = ? WHERE feature = 'linkedin.publish_post'`,
      now,
      now,
    );
    appendAuditEvent(db, {
      event_type: 'capability.publishing_enabled',
      actor,
      subject_type: 'capability',
      subject_id: 'linkedin.publish_post',
      payload: {},
    });
    return { status: 'verified' };
  });
}

export function disablePublishing(
  db: SqliteDriver,
  confirm: boolean,
  actor: AuditActor = 'dashboard',
): { status: string } {
  if (!confirm) {
    throw new DomainError('INVALID_INPUT', 'disabling live publishing requires confirm true');
  }
  return withWriteTx(db, () => {
    const capability = listCapabilities(db, 'linkedin.publish_post')[0];
    if (!capability) {
      throw new DomainError('CAPABILITY_UNAVAILABLE', 'publishing capability is not registered');
    }
    if (capability.status === 'disabled' && capability.blockers.includes('explicitly_disabled')) {
      return { status: 'disabled' };
    }
    const now = new Date().toISOString();
    db.run(
      `UPDATE capabilities SET status = 'disabled', blockers_json = ?, updated_at = ? WHERE feature = 'linkedin.publish_post'`,
      JSON.stringify(['explicitly_disabled']),
      now,
    );
    appendAuditEvent(db, {
      event_type: 'capability.publishing_disabled',
      actor,
      subject_type: 'capability',
      subject_id: 'linkedin.publish_post',
      payload: {},
    });
    return { status: 'disabled' };
  });
}

export function demoteLane(db: SqliteDriver, lane: Lane, status: string, blocker: string): void {
  withWriteTx(db, () => {
    const now = new Date().toISOString();
    for (const feature of LANE_CAPABILITIES[lane]) {
      db.run(
        'UPDATE capabilities SET status = ?, blockers_json = ?, updated_at = ? WHERE feature = ?',
        status,
        JSON.stringify([blocker]),
        now,
        feature,
      );
    }
    appendAuditEvent(db, {
      event_type: 'capability.demoted',
      actor: 'system',
      subject_type: 'capability',
      subject_id: lane,
      payload: { status, blocker },
    });
  });
}
