import { Hono } from 'hono';
import {
  checkCoverage,
  contentOpportunities,
  currentRevision,
  getDraft,
  latestValidation,
  listCalendar,
  listDraftRevisions,
  listDrafts,
  listPillars,
  listPublishedPosts,
  requestApproval,
  upsertCalendarEntry,
  upsertPillar,
  validateDraft,
  voiceProfile,
  writeDraft,
  type CalendarStatus,
} from '@linkedin-mcp/domain';
import { confirmedBody, page, type ApiDeps } from './types.ts';

// Drafts, evidence coverage, opportunities, planning. Nothing here publishes:
// a draft becomes a post only through an approval granted in Publishing.

export function contentRoutes(deps: ApiDeps): Hono {
  const { db } = deps;
  const api = new Hono();

  api.get('/drafts', (c) =>
    c.json({
      drafts: listDrafts(db, { limit: 50 }).map((draft) => ({
        ...draft,
        validation: latestValidation(db, draft.id),
      })),
      calendar: listCalendar(db),
      voice: voiceProfile(db),
    }),
  );

  // The body text, which the old screen never showed — it displayed validation
  // results for a draft the member could not read.
  api.get('/drafts/:id', (c) => {
    const id = c.req.param('id');
    const draft = getDraft(db, id);
    return c.json({
      draft,
      revision: currentRevision(db, id),
      validation: latestValidation(db, id),
      // Through the domain, not raw SQL. A query here is the same layering
      // violation that used to sit in app.ts, and it was worth removing there.
      revisions: listDraftRevisions(db, id, { limit: 20 }),
    });
  });

  api.post('/drafts/:id/validate', async (c) => {
    await confirmedBody(c);
    return c.json({ validation: validateDraft(db, c.req.param('id')) });
  });

  // Editing appends a revision, which invalidates any live approval in the same
  // transaction as the edit. The client says so before it happens.
  api.post('/drafts/:id', async (c) => {
    const body = await confirmedBody<{
      body_text?: string;
      visibility?: 'PUBLIC' | 'CONNECTIONS';
    }>(c);
    const result = writeDraft(db, {
      draft_id: c.req.param('id'),
      body_text: body.body_text ?? '',
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
    });
    return c.json(result);
  });

  // Requesting is not granting. This mints a pending approval bound to the
  // current revision; a human still has to approve the exact bytes in
  // Publishing, in a separate deliberate action.
  api.post('/drafts/:id/approval-request', async (c) => {
    const body = await confirmedBody<{ intended_time?: string }>(c);
    return c.json(
      requestApproval(db, {
        draft_id: c.req.param('id'),
        requested_by: 'dashboard',
        ...(body.intended_time !== undefined ? { intended_time: body.intended_time } : {}),
      }),
    );
  });

  // POST, not GET: checkCoverage writes a content-addressed report row, and
  // navigation must never mutate. The client calls this from an explicit
  // action, never from opening a drawer.
  api.post('/coverage', async (c) => {
    const body = await confirmedBody<{
      text?: string;
      subject?: 'freeform' | 'draft' | 'patch';
      subject_ref?: string;
    }>(c);
    return c.json({
      coverage: checkCoverage(db, {
        text: body.text ?? '',
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        ...(body.subject_ref !== undefined ? { subject_ref: body.subject_ref } : {}),
      }),
    });
  });

  api.get('/opportunities', (c) => {
    const { limit } = page(c);
    const pillarId = c.req.query('pillar_id');
    return c.json({
      opportunities: contentOpportunities(db, {
        limit,
        ...(pillarId ? { pillar_id: pillarId } : {}),
      }),
    });
  });

  api.get('/pillars', (c) => c.json({ pillars: listPillars(db) }));

  api.post('/pillars', async (c) => {
    const body = await confirmedBody<{
      id?: string;
      name?: string;
      description?: string;
      audience?: string;
    }>(c);
    return c.json({
      pillar: upsertPillar(db, {
        ...(body.id !== undefined ? { id: body.id } : {}),
        name: body.name ?? '',
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
      }),
    });
  });

  // Planning metadata only. Nothing in this system fires from a date — there is
  // no scheduler anywhere, by design and by LinkedIn's terms.
  api.post('/calendar', async (c) => {
    const body = await confirmedBody<{
      id?: string;
      draft_id?: string | null;
      pillar_id?: string | null;
      intended_date?: string;
      status?: CalendarStatus;
      note?: string | null;
    }>(c);
    return c.json({
      entry: upsertCalendarEntry(db, {
        ...(body.id !== undefined ? { id: body.id } : {}),
        ...(body.draft_id !== undefined ? { draft_id: body.draft_id } : {}),
        ...(body.pillar_id !== undefined ? { pillar_id: body.pillar_id } : {}),
        ...(body.intended_date !== undefined ? { intended_date: body.intended_date } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      }),
    });
  });

  api.get('/published', (c) =>
    c.json({ posts: listPublishedPosts(db, 100), voice: voiceProfile(db) }),
  );

  return api;
}
