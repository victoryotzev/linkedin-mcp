import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDriver } from '@linkedin-mcp/db';
import { listCapabilities } from './capabilityService.ts';
import { listFeatureControls } from './featureControlService.ts';

// What a person needs to know the first time they open this, and every time
// afterwards when something has stopped working.
//
// Read-only by construction: nothing here creates, enables, migrates or
// verifies. A status screen that repairs things behind you is a status screen
// you cannot trust, and "enable this source" is a decision with its own
// confirmation.

export type CheckStatus =
  /** Working. */
  | 'ok'
  /** Broken or absent, and the member can do something about it. */
  | 'action_needed'
  /**
   * Not available to this member at all — outside the EEA, or on a machine
   * without the credential vault. Distinct from action_needed on purpose:
   * telling someone to fix what they cannot fix is worse than saying nothing.
   */
  | 'unavailable';

export interface ReadinessCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  remediation: string | null;
}

export interface ReadinessReport {
  /** No evidence has ever been enabled, so the ledger cannot answer anything yet. */
  is_first_run: boolean;
  checks: ReadinessCheck[];
  counts: {
    sources_enabled: number;
    sources_pending: number;
    artifacts: number;
    claims_verified: number;
    claims_awaiting_review: number;
  };
  /** The single most useful thing to do next, in plain words. */
  next_step: string;
}

export interface ReadinessInput {
  home: string;
  /** Absolute path to the built dashboard client, when the caller knows it. */
  clientDir?: string;
}

function count(db: SqliteDriver, sql: string, ...params: string[]): number {
  return Number(db.get(sql, ...params)?.['n'] ?? 0);
}

function homeCheck(home: string): ReadinessCheck {
  try {
    accessSync(home, constants.W_OK);
    return {
      id: 'data_home',
      title: 'Application data home',
      status: 'ok',
      detail: `Writable at ${home}`,
      remediation: null,
    };
  } catch {
    return {
      id: 'data_home',
      title: 'Application data home',
      status: 'action_needed',
      detail: `${home} is not writable by this account`,
      remediation:
        'Check the folder permissions, or set LINKEDIN_MCP_HOME to an absolute path you own and restart.',
    };
  }
}

function schemaCheck(db: SqliteDriver): ReadinessCheck {
  // Migrations run automatically at every start, so a shortfall here means a
  // start that failed rather than one that has not happened.
  const applied = count(db, 'SELECT COUNT(*) AS n FROM schema_migrations');
  return applied > 0
    ? {
        id: 'schema',
        title: 'Database schema',
        status: 'ok',
        detail: `${applied} migrations applied`,
        remediation: null,
      }
    : {
        id: 'schema',
        title: 'Database schema',
        status: 'action_needed',
        detail: 'No migrations recorded',
        remediation: 'Restart the server; if it persists, restore from a verified backup.',
      };
}

function dashboardCheck(clientDir: string | undefined): ReadinessCheck {
  if (clientDir === undefined) {
    return {
      id: 'dashboard_build',
      title: 'Dashboard client',
      status: 'ok',
      detail: 'Not checked from this surface',
      remediation: null,
    };
  }
  return existsSync(join(clientDir, 'app.js'))
    ? {
        id: 'dashboard_build',
        title: 'Dashboard client',
        status: 'ok',
        detail: 'Browser bundle is built',
        remediation: null,
      }
    : {
        id: 'dashboard_build',
        title: 'Dashboard client',
        status: 'action_needed',
        detail: 'Browser bundle is missing',
        remediation: 'Run: npm run build -w @linkedin-mcp/dashboard',
      };
}

function linkedInCheck(db: SqliteDriver): ReadinessCheck {
  const capabilities = listCapabilities(db);
  const verified = capabilities.filter((c) => c.status === 'verified');
  if (verified.length > 0) {
    return {
      id: 'linkedin',
      title: 'LinkedIn connection',
      status: 'ok',
      detail: `${verified.length} of ${capabilities.length} capabilities verified`,
      remediation: null,
    };
  }
  // Not action_needed. Without a developer app there is nothing to fix, and
  // outside the EEA or Switzerland the read lane cannot be provisioned at all.
  return {
    id: 'linkedin',
    title: 'LinkedIn connection',
    status: 'unavailable',
    detail: 'No verified LinkedIn credential. Everything that does not touch LinkedIn still works.',
    remediation:
      'Optional. See docs/linkedin-app-setup.md. Token generation requires a LinkedIn member in the EEA or Switzerland.',
  };
}

function publishingCheck(db: SqliteDriver): ReadinessCheck {
  const live = listFeatureControls(db).find((f) => f.key === 'live_publishing');
  return {
    id: 'live_publishing',
    title: 'Real publishing',
    status: 'ok',
    detail: live?.enabled ? 'Enabled' : 'Disabled, which is the default',
    remediation: null,
  };
}

function evidenceCheck(enabled: number, pending: number): ReadinessCheck {
  if (enabled > 0) {
    return {
      id: 'evidence',
      title: 'Evidence',
      status: 'ok',
      detail: `${enabled} enabled source${enabled === 1 ? '' : 's'}`,
      remediation: null,
    };
  }
  return {
    id: 'evidence',
    title: 'Evidence',
    status: 'action_needed',
    detail:
      pending > 0
        ? `${pending} source${pending === 1 ? '' : 's'} registered but not yet enabled`
        : 'Nothing imported yet',
    remediation:
      pending > 0
        ? 'Review the path and trust class, then confirm ENABLE <source_id>.'
        : 'Add a CV, a folder of documents, or type a short description of yourself.',
  };
}

export function readinessReport(db: SqliteDriver, input: ReadinessInput): ReadinessReport {
  const counts = {
    sources_enabled: count(db, "SELECT COUNT(*) AS n FROM sources WHERE status = 'enabled'"),
    sources_pending: count(db, "SELECT COUNT(*) AS n FROM sources WHERE status = 'pending_review'"),
    artifacts: count(db, 'SELECT COUNT(*) AS n FROM artifacts WHERE superseded_by IS NULL'),
    claims_verified: count(db, "SELECT COUNT(*) AS n FROM claims WHERE state = 'verified'"),
    claims_awaiting_review: count(db, "SELECT COUNT(*) AS n FROM claims WHERE state = 'candidate'"),
  };

  const checks: ReadinessCheck[] = [
    homeCheck(input.home),
    schemaCheck(db),
    dashboardCheck(input.clientDir),
    evidenceCheck(counts.sources_enabled, counts.sources_pending),
    linkedInCheck(db),
    publishingCheck(db),
  ];

  const isFirstRun = counts.sources_enabled === 0 && counts.artifacts === 0;

  return { is_first_run: isFirstRun, checks, counts, next_step: nextStep(counts, checks) };
}

function nextStep(counts: ReadinessReport['counts'], checks: ReadinessCheck[]): string {
  // A broken environment outranks any amount of work waiting, because none of
  // the work can be done until it is fixed.
  const broken = checks.find((c) => c.status === 'action_needed' && c.id !== 'evidence');
  if (broken) return `${broken.title}: ${broken.remediation ?? broken.detail}`;

  if (counts.sources_pending > 0) {
    return 'Review each registered source, then confirm ENABLE <source_id> for the ones you trust.';
  }
  if (counts.sources_enabled === 0) {
    return 'Add your first evidence: a CV, a folder of documents, or a short description you type yourself.';
  }
  if (counts.artifacts === 0) {
    return 'Import from an enabled source so there is something to draw claims from.';
  }
  if (counts.claims_awaiting_review > 0) {
    return `Review ${counts.claims_awaiting_review} candidate claim(s); only verified claims can back profile text or a post.`;
  }
  if (counts.claims_verified === 0) {
    return 'Propose claims from the imported evidence, citing the artifacts they come from.';
  }
  return 'Ready. Build a profile section or draft a post from your verified claims.';
}
