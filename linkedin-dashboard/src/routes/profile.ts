import { Hono } from 'hono';
import {
  diffProfile,
  exportChangeSet,
  getChangeSet,
  getProfile,
  listChangeSets,
  listSnapshots,
  markPatchApplied,
  reviewPatch,
  scoreProfile,
  type DiffRef,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';
import { confirmedBody, page, type ApiDeps } from './types.ts';

// Canonical sections, snapshots, the diff against LinkedIn, and the copy/paste
// change sets that are the only way a profile field ever changes.

const DIFF_REF = /^(canonical|snapshot:latest|snapshot:snp_[A-Za-z0-9]+)$/;

export function profileRoutes(deps: ApiDeps): Hono {
  const { db } = deps;
  const api = new Hono();

  api.get('/profile', (c) =>
    c.json({
      sections: getProfile(db),
      snapshots: listSnapshots(db).slice(0, 10),
      scores: scoreProfile(db),
    }),
  );

  // Constrained to the two shapes the domain understands, rather than passing a
  // caller-supplied string into a resolver that reads snapshots by id.
  api.get('/profile/diff', (c) => {
    const left = c.req.query('left') ?? 'canonical';
    const right = c.req.query('right') ?? 'snapshot:latest';
    for (const ref of [left, right]) {
      if (!DIFF_REF.test(ref)) {
        throw new DomainError(
          'INVALID_INPUT',
          `diff refs must be 'canonical', 'snapshot:latest' or 'snapshot:<id>'; got '${ref}'`,
        );
      }
    }
    return c.json({ diff: diffProfile(db, left as DiffRef, right as DiffRef), left, right });
  });

  api.get('/changesets', (c) => {
    const { limit, offset } = page(c);
    return c.json({ change_sets: listChangeSets(db, { limit, offset }) });
  });

  api.get('/changesets/:id', (c) => c.json({ change_set: getChangeSet(db, c.req.param('id')) }));

  // The apply step. LinkedIn has no profile-edit API, so this bundle — exact
  // text plus the path to the field in LinkedIn's own UI — IS how a profile
  // changes. It was reachable only from MCP before, which put the actual doing
  // of the work outside the surface built for the human.
  api.post('/changesets/:id/export', async (c) => {
    await confirmedBody(c);
    return c.json({ bundle: exportChangeSet(db, c.req.param('id')) });
  });

  api.post('/patches/:id/review', async (c) => {
    const body = await confirmedBody<{
      action?: 'accept' | 'reject' | 'edit' | 'supersede';
      new_text?: string;
      note?: string;
    }>(c);
    return c.json({
      patch: reviewPatch(db, {
        patch_id: c.req.param('id'),
        action: body.action ?? 'accept',
        ...(body.new_text !== undefined ? { new_text: body.new_text } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      }),
    });
  });

  api.post('/patches/:id/applied', async (c) => {
    await confirmedBody(c);
    return c.json({
      patch: markPatchApplied(db, {
        patch_id: c.req.param('id'),
        confirm: true,
        actor: 'dashboard',
      }),
    });
  });

  return api;
}
