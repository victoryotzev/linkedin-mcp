import { describe, expect, it } from 'vitest';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { createFixture } from '../helpers/fixtures.ts';

// The cutover gate, kept after cutover.
//
// The previous dashboard did not move until the replacement could do
// everything it did, and this is the mechanical record of what that was: every
// operation ui.ts performed, and the route that now serves it. The old file is
// gone (`git show e2f676c:apps/dashboard/src/ui.ts` if it is ever wanted), so
// this list is now the memory of it — a route disappearing here means a
// capability the dashboard used to have has been lost.

const LEGACY_OPERATIONS: Array<{ what: string; method: string; path: string }> = [
  { what: 'enable a source from the dashboard', method: 'POST', path: '/api/sources/:id/enable' },
  { what: 'list sources', method: 'GET', path: '/api/sources' },
  { what: 'list claims for review', method: 'GET', path: '/api/claims' },
  { what: 'show the evidence behind a claim', method: 'GET', path: '/api/claims/:id/evidence' },
  {
    what: 'verify a claim (and verify-as-familiarity-only)',
    method: 'POST',
    path: '/api/claims/:id/verify',
  },
  { what: 'reject a claim permanently', method: 'POST', path: '/api/claims/:id/reject' },
  { what: 'list conflicts', method: 'GET', path: '/api/conflicts' },
  { what: 'resolve or dismiss a conflict', method: 'POST', path: '/api/conflicts/:id/resolve' },
  { what: 'list artifacts', method: 'GET', path: '/api/artifacts' },
  { what: 'read the canonical profile, snapshots and scores', method: 'GET', path: '/api/profile' },
  { what: 'list change sets', method: 'GET', path: '/api/changesets' },
  {
    what: 'accept, reject, edit or supersede a patch',
    method: 'POST',
    path: '/api/patches/:id/review',
  },
  { what: 'mark a patch applied', method: 'POST', path: '/api/patches/:id/applied' },
  { what: 'list drafts, calendar and voice profile', method: 'GET', path: '/api/drafts' },
  { what: 'read analytics observations', method: 'GET', path: '/api/analytics' },
  { what: 'read capabilities, retention and lanes', method: 'GET', path: '/api/system' },
  { what: 'store a credential from the dashboard', method: 'POST', path: '/api/lanes/:lane/token' },
  { what: 'verify a lane against LinkedIn', method: 'POST', path: '/api/lanes/:lane/verify' },
  { what: 'enable publishing', method: 'POST', path: '/api/capabilities/publishing/enable' },
  { what: 'list approvals with the byte-exact preview', method: 'GET', path: '/api/approvals' },
  { what: 'grant an approval', method: 'POST', path: '/api/approvals/:id/grant' },
  { what: 'deny an approval', method: 'POST', path: '/api/approvals/:id/deny' },
  { what: 'list publications', method: 'GET', path: '/api/publications' },
  {
    what: 'reconcile an ambiguous publication',
    method: 'POST',
    path: '/api/publications/:id/reconcile',
  },
];

describe('the replacement can do everything the previous dashboard could', () => {
  const fixture = createFixture('parity');
  const app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth: new DashboardAuth(4780),
  });
  const registered = new Set(app.routes.map((route) => `${route.method} ${route.path}`));

  it('registers a route for every legacy operation', () => {
    const missing = LEGACY_OPERATIONS.filter(
      (operation) => !registered.has(`${operation.method} ${operation.path}`),
    ).map((operation) => `${operation.what} (${operation.method} ${operation.path})`);
    expect(missing).toEqual([]);
    fixture.close();
  });

  it('covers every consequential operation the previous dashboard could perform', () => {
    // A list that quietly shrank would make this test pass while measuring
    // less. The six that carry authority are named individually.
    expect(LEGACY_OPERATIONS.length).toBeGreaterThanOrEqual(24);
    for (const path of [
      '/api/sources/:id/enable',
      '/api/approvals/:id/grant',
      '/api/approvals/:id/deny',
      '/api/lanes/:lane/token',
      '/api/lanes/:lane/verify',
      '/api/capabilities/publishing/enable',
    ]) {
      expect(
        LEGACY_OPERATIONS.some((operation) => operation.path === path),
        `${path} is a consequential dashboard operation and must stay in the parity list`,
      ).toBe(true);
    }
  });
});
