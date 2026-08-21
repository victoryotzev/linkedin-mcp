import type { FeatureKey } from '@linkedin-mcp/domain';

/** Maps purpose-built dashboard API routes to the same controls as MCP tools. */
export function dashboardFeatureForPath(path: string): FeatureKey | null {
  const route = path.replace(/^\/api/, '');
  if (/^\/artifacts\/[^/]+\/purge$/.test(route)) return 'maintenance';
  if (/^\/drafts\/[^/]+\/approval-request$/.test(route)) return 'publication_workflow';
  // Ungated, matching linkedin_readiness_check: the screen that explains why
  // nothing works must not disappear when a feature is switched off.
  if (route === '/readiness') return null;
  if (/^\/intake(\/|$)/.test(route)) return 'evidence';
  if (/^\/(sources|claims|conflicts|artifacts|coverage)(\/|$)/.test(route)) return 'evidence';
  if (/^\/(profile|changesets|patches)(\/|$)/.test(route)) return 'profile';
  if (/^\/(drafts|opportunities|pillars|calendar|published)(\/|$)/.test(route)) return 'content';
  if (/^\/(approvals|publications|audit|system\/chain)(\/|$)/.test(route)) {
    return 'publication_workflow';
  }
  if (/^\/analytics(\/|$)/.test(route)) return 'analytics';
  if (/^\/lanes\/(read|write)\/verify$/.test(route)) return 'linkedin_sync';
  if (/^\/(backups|export-bundle|purge-all)(\/|$)/.test(route)) return 'maintenance';
  return null;
}
