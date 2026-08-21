import { Hono } from 'hono';
import {
  enableSourceFromDashboard,
  getArtifactDetail,
  getClaimEvidence,
  listArtifacts,
  listClaims,
  listConflicts,
  listSources,
  rejectClaim,
  resolveConflict,
  verifyClaim,
  type ClaimListFilters,
  type ClaimSensitivity,
  type ClaimState,
  type ConflictState,
  type MemberAction,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { confirmedBody, page, paginate, type ApiDeps } from './types.ts';

// Sources, claims, conflicts, artifacts — the evidence ledger.

export function evidenceRoutes(deps: ApiDeps): Hono {
  const { db, store, fts5 } = deps;
  const api = new Hono();

  api.get('/sources', (c) => c.json({ sources: listSources(db) }));

  api.post('/sources/:id/enable', async (c) => {
    await confirmedBody(c);
    return c.json({ source: enableSourceFromDashboard(db, c.req.param('id')) });
  });

  // Every filter listClaims supports is reachable. The old screen hard-coded
  // state=candidate, which made the expired queue unreachable — and the boot
  // retention sweep demotes verified claims to 'expired' whenever their
  // review-by passes, so claims were leaving the corpus with nothing surfacing
  // it anywhere in the product.
  api.get('/claims', (c) => {
    const filters: ClaimListFilters = {};
    const state = c.req.query('state');
    if (state) filters.state = state as ClaimState;
    if (c.req.query('stale') === 'true') filters.stale = true;
    const q = c.req.query('q');
    if (q) filters.q = q;
    const sensitivity = c.req.query('sensitivity');
    if (sensitivity) filters.sensitivity = sensitivity as ClaimSensitivity;
    const artifactId = c.req.query('artifact_id');
    if (artifactId) filters.artifact_id = artifactId;

    return c.json({ claims: paginate(listClaims(db, filters, fts5), page(c)) });
  });

  api.get('/claims/:id/evidence', (c) => {
    const claimId = c.req.param('id');
    // One artifact can back several evidence rows (different line ranges of the
    // same file). getArtifactDetail re-reads and re-hashes the whole file every
    // call, so the naive map did that work once per row. The integrity check is
    // deliberately kept — it is the signal the store exists to produce — and
    // memoised for the life of this request instead.
    const seen = new Map<string, { excerpt: string | null; integrity_error: string | null }>();
    const evidence = getClaimEvidence(db, claimId).map((ev) => {
      const cached = seen.get(ev.artifact_id);
      if (cached) return { ...ev, ...cached };

      let excerpt: string | null = null;
      let integrity_error: string | null = null;
      try {
        excerpt = getArtifactDetail(db, store, ev.artifact_id).preview;
      } catch (err) {
        // A bare catch here turned the one signal the content-addressed store
        // exists to produce — stored bytes no longer hashing to the recorded
        // sha256 — into an indistinguishable "no text preview", on the very
        // screen where the member decides whether to verify the claim.
        integrity_error =
          err instanceof DomainError && err.code === 'INTEGRITY_ERROR' ? err.message : null;
      }
      seen.set(ev.artifact_id, { excerpt, integrity_error });
      return { ...ev, excerpt, integrity_error };
    });
    return c.json({ evidence });
  });

  api.post('/claims/:id/verify', async (c) => {
    const body = await confirmedBody<{ limitations?: string; clone_reference_ack?: boolean }>(c);
    const claim = verifyClaim(db, {
      claim_id: c.req.param('id'),
      confirm: true,
      ...(body.clone_reference_ack !== undefined
        ? { clone_reference_ack: body.clone_reference_ack }
        : {}),
      reviewer: 'user:dashboard',
      ...(body.limitations !== undefined ? { limitations: body.limitations } : {}),
    });
    return c.json({ claim });
  });

  api.post('/claims/:id/reject', async (c) => {
    const body = await confirmedBody<{ reason?: string }>(c);
    const claim = rejectClaim(db, {
      claim_id: c.req.param('id'),
      reason: body.reason ?? '',
      confirm: true,
      reviewer: 'user:dashboard',
    });
    return c.json({ claim });
  });

  api.get('/conflicts', (c) => {
    // Defaults to open, which is all the old screen could show; resolved and
    // dismissed history is now reachable too.
    const state = c.req.query('state') ?? 'open';
    return c.json({
      conflicts: listConflicts(db, state === 'all' ? {} : { state: state as ConflictState }),
    });
  });

  api.post('/conflicts/:id/resolve', async (c) => {
    const body = await confirmedBody<{
      resolution?: 'resolved' | 'dismissed';
      note?: string;
      member_actions?: MemberAction[];
    }>(c);
    const conflict = resolveConflict(db, {
      conflict_id: c.req.param('id'),
      resolution: body.resolution ?? 'resolved',
      note: body.note ?? '',
      ...(body.member_actions !== undefined ? { member_actions: body.member_actions } : {}),
      confirm: true,
      reviewer: 'user:dashboard',
    });
    return c.json({ conflict });
  });

  api.get('/artifacts', (c) => {
    const filters: Parameters<typeof listArtifacts>[1] = {};
    const sourceId = c.req.query('source_id');
    if (sourceId) filters.source_id = sourceId;
    const mime = c.req.query('mime');
    if (mime) filters.mime = mime;
    const q = c.req.query('q');
    if (q) filters.q = q;
    if (c.req.query('include_superseded') === 'true') filters.include_superseded = true;

    return c.json({ artifacts: paginate(listArtifacts(db, filters, fts5), page(c)) });
  });

  api.get('/artifacts/:id', (c) =>
    c.json({ artifact: getArtifactDetail(db, store, c.req.param('id')) }),
  );

  return api;
}
