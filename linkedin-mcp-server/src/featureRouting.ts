import type { FeatureKey } from '@linkedin-mcp/domain';

const EXACT: Partial<Record<string, FeatureKey>> = {
  linkedin_capability_status: 'configuration',
  linkedin_capability_verify: 'linkedin_sync',
  linkedin_dma_sync: 'linkedin_sync',
  // Named for the profile because that is what it returns, but it is a live
  // LinkedIn read. The prefix rule below would file it under 'profile', which
  // would leave it running with the sync feature switched off.
  linkedin_profile_read_latest: 'linkedin_sync',
  linkedin_settings_set: 'configuration',
  linkedin_backup_run: 'maintenance',
  linkedin_purge_run: 'maintenance',
  // Creates evidence, so it belongs to the group that governs evidence even
  // though the name does not start with one of the evidence prefixes.
  linkedin_intake_describe: 'evidence',
  linkedin_analytics_import: 'analytics',
  linkedin_analytics_query: 'analytics',
  linkedin_publish_request: 'publication_workflow',
  linkedin_approval_status: 'publication_workflow',
  linkedin_approval_decide: 'publication_workflow',
  linkedin_publish_execute: 'publication_workflow',
  linkedin_publication_reconcile: 'publication_workflow',
  linkedin_audit_query: 'publication_workflow',
};

export function featureForTool(name: string): FeatureKey | null {
  // Ungated, for the same reason feature control is: a tool whose whole job is
  // reporting what is switched off must not be switchable off. Disabling
  // 'configuration' to narrow what an agent can touch should not also remove
  // the way to find out why nothing works.
  if (name === 'linkedin_feature_control' || name === 'linkedin_readiness_check') return null;
  const exact = EXACT[name];
  if (exact) return exact;
  if (/^linkedin_(source|import|artifact|claim|conflict|coverage)_/.test(name)) return 'evidence';
  if (/^linkedin_(profile|snapshot|changeset|patch)_/.test(name)) return 'profile';
  if (/^linkedin_(content|voice|published|draft|calendar)_/.test(name)) return 'content';
  throw new Error(`MCP tool ${name} has no shared feature group`);
}
