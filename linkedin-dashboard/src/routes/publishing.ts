import { Hono } from 'hono';
import {
  approvalPreview,
  denyApproval,
  grantApproval,
  listApprovals,
  listPublications,
  reconcilePublication,
  verifyAuditChain,
} from '@linkedin-mcp/domain';
import { confirmedBody, type ApiDeps } from './types.ts';

// Purpose-built visual authority surface. MCP can perform the same publication
// decision only through a separately confirmed, id-and-revision-bound command.

export function publishingRoutes(deps: ApiDeps): Hono {
  const { db } = deps;
  const api = new Hono();

  api.get('/approvals', (c) => {
    // Previews only for the states the UI renders one for. This used to build a
    // preview for EVERY approval ever created — three queries each — so the
    // cost of opening the screen grew without bound while the extra previews
    // were never displayed.
    const approvals = listApprovals(db).map((approval) => {
      if (approval.state !== 'pending' && approval.state !== 'granted') {
        return { ...approval, preview: null };
      }
      try {
        return { ...approval, preview: approvalPreview(db, approval.id) };
      } catch {
        // A bound revision missing from history is an integrity failure, not a
        // reason to substitute the current text. The preview is simply absent
        // and the screen says so.
        return { ...approval, preview: null };
      }
    });
    return c.json({ approvals, chain: verifyAuditChain(db) });
  });

  api.post('/approvals/:id/grant', async (c) => {
    await confirmedBody(c);
    return c.json({ approval: grantApproval(db, c.req.param('id')) });
  });

  api.post('/approvals/:id/deny', async (c) => {
    const body = await confirmedBody<{ reason?: string }>(c);
    return c.json({
      approval: denyApproval(db, c.req.param('id'), body.reason ?? 'denied in dashboard'),
    });
  });

  api.get('/publications', (c) => c.json({ publications: listPublications(db) }));

  api.post('/publications/:id/reconcile', async (c) => {
    const body = await confirmedBody<{ found?: boolean; post_url?: string }>(c);
    return c.json({
      publication: reconcilePublication(db, {
        publication_id: c.req.param('id'),
        method: 'manual_attestation',
        found: body.found === true,
        confirm: true,
        actor: 'dashboard',
        ...(body.post_url !== undefined ? { post_url: body.post_url } : {}),
      }),
    });
  });

  return api;
}
