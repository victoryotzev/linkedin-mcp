import * as z from 'zod/v4';
import {
  PROFILE_SNAPSHOT_DOMAINS,
  createSecretStore,
  laneToken,
  listCapabilities,
  probeLane,
  readLatestProfileFromDma,
  requireCapability,
  syncFromDma,
  syncChangelogFromDma,
  verifyLane,
} from '@linkedin-mcp/domain';
import { DMA_ALLOWED_DOMAINS, DmaClient } from '@linkedin-mcp/linkedin';
import { contextActor, type AppContext } from '../bootstrap.ts';
import { defineTool, type ToolDef } from '../registry.ts';

// External-read tools. They exist in the surface from day one — hidden tools
// would be worse than honest blockers — but the capability gate refuses every
// call until a LinkedIn app exists and a human verifies it in the dashboard.
// The gate runs before any adapter is constructed, so no socket is opened.

const localeInput = z
  .string()
  .regex(/^[a-z]{2}_[A-Z]{2}$/)
  .describe("preferred locale for localized values, e.g. 'en_US' or 'bg_BG'");

const domainStatus = z.enum(['populated', 'empty_or_not_ready', 'failed', 'pagination_incomplete']);

const domainResultShape = z.object({
  domain: z.string(),
  status: domainStatus,
  rows_fetched: z.number(),
  imported: z.number(),
  skipped: z.number(),
  failure_reason: z.string().optional(),
  carried_forward_from: z.string().optional(),
  note: z.string().optional(),
});

const observationShape = z.object({
  id: z.string(),
  snapshot_created: z.boolean(),
  requested_at: z.string(),
  request_completed_at: z.string(),
  observed_at: z.string(),
  content_fingerprint: z.string(),
  content_identical_to_previous: z.boolean(),
});

const changelogShape = z.object({
  window_start_ms: z.number(),
  watermark_ms: z.number(),
  cursor_ms: z.number().nullable(),
  cursor_advanced: z.boolean(),
  newest_processed_at_ms: z.number().nullable(),
  events_without_processed_at: z.number(),
  rows_fetched: z.number(),
  imported: z.number(),
  duplicates: z.number(),
  synced_at: z.string(),
});

const freshnessStatus = z.enum([
  'observed_no_newer_profile_event',
  'upstream_snapshot_lag_detected',
  'event_overlay_partial',
  'partial_domain_fetch',
  'unknown',
]);

const freshnessShape = z.object({
  // Structural. LinkedIn's Snapshot response carries no completeness marker and
  // no generation timestamp, and the portability terms forbid implying LinkedIn
  // verified or confirmed anything, so there is no other value this can take.
  guarantee: z.literal('not_guaranteed'),
  status: freshnessStatus,
  secondary_signals: z.array(freshnessStatus),
  reasons: z.array(z.string()),
  recommended_next_action: z.string(),
  observation_id: z.string(),
  snapshot_id: z.string().nullable(),
  content_fingerprint: z.string(),
  content_changed_from_previous: z.boolean().nullable(),
  requested_at: z.string(),
  request_completed_at: z.string(),
  observed_at: z.string(),
  domains: z.object({
    requested: z.array(z.string()),
    populated: z.array(z.string()),
    empty_or_not_ready: z.array(z.string()),
    failed: z.array(z.string()),
    pagination_incomplete: z.array(z.string()),
    carried_forward: z.array(z.string()),
    not_requested: z.array(z.string()),
  }),
  changelog_cursor_ms: z.number().nullable(),
  changelog_window_days: z.number(),
  newest_profile_event: z
    .object({
      resource_name: z.string().nullable(),
      method: z.string().nullable(),
      captured_at_ms: z.number().nullable(),
      processed_at_ms: z.number().nullable(),
    })
    .nullable(),
  newer_relevant_event_count: z.number(),
  applied_overlay: z.array(
    z.object({
      kind: z.enum([
        'person_field',
        'position_created',
        'position_updated',
        'position_deleted',
        // Any other people/<collection> — certifications, educations, skills.
        'resource_created',
        'resource_updated',
        'resource_deleted',
      ]),
      resource_name: z.string(),
      resource_id: z.string().nullable(),
      method: z.string(),
      field: z.string().nullable(),
      summary: z.string(),
      captured_at_ms: z.number().nullable(),
      processed_at_ms: z.number().nullable(),
    }),
  ),
  unresolved_changes: z.array(
    z.object({
      reason: z.enum([
        'unknown_resource_partial_update',
        'unknown_resource_delete',
        'empty_activity',
        'failed_processing',
        'missing_resource_id',
        'unmapped_person_field',
        'unsupported_resource_or_version',
      ]),
      resource_name: z.string().nullable(),
      resource_id: z.string().nullable(),
      method: z.string().nullable(),
      config_version: z.number().nullable(),
      activity_status: z.string().nullable(),
      captured_at_ms: z.number().nullable(),
      processed_at_ms: z.number().nullable(),
      detail: z.string(),
    }),
  ),
  event_derived: z.object({
    person: z.record(z.string(), z.string()),
    positions: z.array(
      z.object({ resource_id: z.string(), fields: z.record(z.string(), z.unknown()) }),
    ),
    /** Keyed by collection name: certifications, educations, skills, … */
    collections: z.record(
      z.string(),
      z.array(z.object({ resource_id: z.string(), fields: z.record(z.string(), z.unknown()) })),
    ),
  }),
  truncated: z.object({
    applied_overlay: z.boolean(),
    unresolved_changes: z.boolean(),
    event_derived_positions: z.boolean(),
    applied_overlay_total: z.number(),
    unresolved_changes_total: z.number(),
    event_derived_positions_total: z.number(),
  }),
});

export function externalTools(ctx: AppContext): ToolDef[] {
  const actor = contextActor(ctx);
  return [
    defineTool({
      name: 'linkedin_capability_verify',
      title: 'Verify a capability against LinkedIn',
      description:
        'Probe LinkedIn to confirm a configured capability actually works, then record the result. Requires a stored token, which is entered in the dashboard or masked companion CLI and never passes through MCP. Fails closed with the exact blocker while no developer app exists.',
      inputSchema: z.object({
        feature: z.enum([
          'linkedin.oidc_userinfo',
          'linkedin.dma_snapshot',
          'linkedin.dma_changelog',
          'linkedin.publish_post',
          'linkedin.image_upload',
        ]),
      }),
      outputSchema: z.object({
        feature: z.string(),
        status: z.string(),
        blockers: z.array(z.string()),
        remediation: z.string(),
        probed: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      permission: 'external-read',
      handler: async ({ feature }) => {
        // Verification is a live call, so it runs against the lane the feature
        // belongs to. It never sees the token: the secret store hands it
        // straight to the probe.
        const lane = feature.startsWith('linkedin.dma') ? 'read' : 'write';
        const store = createSecretStore(ctx.db, ctx.home);
        await verifyLane(ctx.db, store, lane, (token) => probeLane(lane, token), actor);
        const capability = listCapabilities(ctx.db, feature)[0]!;
        return {
          feature: capability.feature,
          status: capability.status,
          blockers: capability.blockers,
          remediation: capability.remediation,
          probed: true,
        };
      },
    }),

    defineTool({
      name: 'linkedin_dma_sync',
      title: 'Sync own LinkedIn data (EU portability lane)',
      description:
        "Pull the member's own data through the EU Data Portability API: Snapshot for profile and post history, Changelog for the rolling 28-day event window. Runs only when invoked — this app ships no scheduler — and sensitive domains (messages, connections, logins, ad profiling) are excluded by default. Snapshot mode defaults to all ten profile domains plus post history, which is ten-plus paginated walks against LinkedIn; pass `domains` to narrow it. The result reports every domain's outcome separately, because LinkedIn collates domains at different times and a domain returning nothing is not proof the section is empty. For a profile-focused live read with lag analysis, use linkedin_profile_read_latest.",
      inputSchema: z.object({
        mode: z.enum(['snapshot', 'changelog']).default('snapshot'),
        // .min(1): an empty array is not "use the defaults", it is a live read
        // that fetches nothing, and it used to be accepted.
        domains: z.array(z.enum(DMA_ALLOWED_DOMAINS)).min(1).optional(),
        preferred_locale: localeInput.optional(),
      }),
      outputSchema: z.object({
        mode: z.string(),
        domains: z.array(z.string()),
        imported: z.number(),
        snapshot_id: z.string().nullable(),
        window_note: z.string(),
        domain_results: z.array(domainResultShape),
        observation: observationShape.nullable(),
        changelog: changelogShape.nullable(),
        freshness: freshnessShape.nullable(),
      }),
      annotations: {
        // Writes an observation and possibly a snapshot on every call, and each
        // call is a fresh set of upstream requests.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      permission: 'external-read',
      handler: async ({ mode, domains, preferred_locale }) => {
        requireCapability(
          ctx.db,
          mode === 'snapshot' ? 'linkedin.dma_snapshot' : 'linkedin.dma_changelog',
        );
        const store = createSecretStore(ctx.db, ctx.home);
        const token = await laneToken(ctx.db, store, 'read');
        const client = new DmaClient({ accessToken: token });

        if (mode === 'changelog') {
          const report = await syncChangelogFromDma(ctx.db, client, { actor });
          return {
            mode,
            domains: [],
            imported: report.imported,
            snapshot_id: null,
            window_note: `${report.rows_fetched} changelog event(s) fetched; ${report.imported} stored durably, ${report.duplicates} duplicate(s); next startTime ${report.cursor_ms ?? '(full 28-day window)'}`,
            domain_results: [],
            observation: null,
            changelog: report,
            freshness: null,
          };
        }

        const report = await syncFromDma(ctx.db, client, {
          ...(domains !== undefined ? { domains } : {}),
          ...(preferred_locale !== undefined ? { locale: preferred_locale } : {}),
          actor,
        });
        const failed = report.domains.filter((d) => d.status !== 'populated');
        return {
          mode,
          domains: report.domains.map((d) => d.domain),
          imported: report.domains.reduce((sum, d) => sum + d.imported, 0),
          snapshot_id: report.snapshot_id,
          window_note:
            `snapshot ${report.snapshot_id ?? '(none)'}; ${report.posts_imported} post(s) imported; ` +
            `freshness ${report.freshness.status}` +
            (failed.length > 0
              ? `; ${failed.length} domain(s) not populated: ${failed.map((d) => `${d.domain}=${d.status}`).join(', ')}`
              : ''),
          domain_results: report.domains,
          observation: report.observation,
          changelog: null,
          freshness: report.freshness,
        };
      },
    }),

    defineTool({
      name: 'linkedin_profile_read_latest',
      title: 'Read the latest LinkedIn profile (live)',
      description:
        "Initiate a NEW read of the member's own profile through the EU Data Portability lane: reconcile the Member Changelog, then fetch all ten non-sensitive profile Snapshot domains. Every call issues fresh upstream requests — unlike linkedin_profile_get, which returns the local canonical profile and calls nothing. It cannot promise the answer is current: LinkedIn's Snapshot response carries no generation timestamp and no completeness marker, and its Snapshot can lag behind its own Changelog. Any domain LinkedIn did not answer keeps its previously observed value, named in freshness.domains.carried_forward, so `observed` is the effective profile rather than this response alone. The result reports what was observed, which changelog changes could be reconciled deterministically, which could not, per-domain status, and a freshness verdict that is always guarantee=not_guaranteed. Canonical sections are never modified; use linkedin_profile_update for that.",
      inputSchema: z.object({
        domains: z
          .array(z.enum(PROFILE_SNAPSHOT_DOMAINS))
          .min(1)
          .optional()
          .describe('defaults to all ten non-sensitive profile domains'),
        sync_changelog: z
          .boolean()
          .default(true)
          .describe('reconcile the Member Changelog before reading the Snapshot'),
        preferred_locale: localeInput.optional(),
      }),
      outputSchema: z.object({
        observed: z.record(z.string(), z.string()),
        snapshot_id: z.string().nullable(),
        observation: observationShape,
        domains: z.array(domainResultShape),
        changelog: changelogShape.nullable(),
        changelog_error: z.string().nullable(),
        freshness: freshnessShape,
      }),
      annotations: {
        // Not read-only and not idempotent: every call issues fresh upstream
        // requests and durably records an observation. It does not modify
        // anything at LinkedIn, which is why destructiveHint stays false.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      permission: 'external-read',
      handler: async ({ domains, sync_changelog, preferred_locale }) => {
        // Gates first, exactly as the sync tool does: nothing is constructed and
        // no socket is opened while the lane is closed.
        if (sync_changelog) requireCapability(ctx.db, 'linkedin.dma_changelog');
        requireCapability(ctx.db, 'linkedin.dma_snapshot');
        const store = createSecretStore(ctx.db, ctx.home);
        const token = await laneToken(ctx.db, store, 'read');
        const client = new DmaClient({ accessToken: token });

        const result = await readLatestProfileFromDma(ctx.db, client, {
          ...(domains !== undefined ? { domains } : {}),
          ...(preferred_locale !== undefined ? { locale: preferred_locale } : {}),
          syncChangelog: sync_changelog,
          actor,
        });
        return {
          observed: result.observed,
          snapshot_id: result.snapshot_id,
          observation: result.observation,
          domains: result.domains,
          changelog: result.changelog,
          changelog_error: result.changelog_error,
          freshness: result.freshness,
        };
      },
    }),
  ];
}
