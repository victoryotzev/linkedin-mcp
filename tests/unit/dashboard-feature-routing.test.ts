import { describe, expect, it } from 'vitest';
import { dashboardFeatureForPath } from '../../linkedin-dashboard/src/featureRouting.ts';

describe('dashboard feature routing', () => {
  it.each([
    ['/api/sources', 'evidence'],
    ['/api/claims/one/reject', 'evidence'],
    ['/api/profile/diff', 'profile'],
    ['/api/drafts/one', 'content'],
    ['/api/drafts/one/approval-request', 'publication_workflow'],
    ['/api/approvals', 'publication_workflow'],
    ['/api/analytics', 'analytics'],
    ['/api/lanes/write/verify', 'linkedin_sync'],
    ['/api/backups', 'maintenance'],
    ['/api/artifacts/one/purge', 'maintenance'],
  ] as const)('maps %s to %s', (path, feature) => {
    expect(dashboardFeatureForPath(path)).toBe(feature);
  });

  it('keeps credentials, feature recovery, system status, and tool discovery reachable', () => {
    for (const path of [
      '/api/system',
      '/api/features/evidence',
      '/api/lanes/write/token',
      '/api/tools',
      '/api/tools/linkedin_claim_manage/run',
    ]) {
      expect(dashboardFeatureForPath(path)).toBeNull();
    }
  });
});
