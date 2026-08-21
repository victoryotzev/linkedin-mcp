import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  ensureLocalAccount,
  executePublication,
  getApproval,
  proposeClaim,
  requestApproval,
  validateDraft,
  verifyClaim,
  writeDraft,
} from '@linkedin-mcp/domain';
import { DryRunPublisher } from '@linkedin-mcp/linkedin';
import { DomainError } from '@linkedin-mcp/shared';
import { DashboardAuth } from '../../linkedin-dashboard/src/auth.ts';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { publishTools } from '../../linkedin-mcp-server/src/tools/publish.ts';
import { seedSourceAndArtifact } from '../helpers/seed.ts';
import type { Hono } from 'hono';

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;
const BODY =
  'I authored a hosting and DNS MCP server exposing roughly sixty curated tools in strict TypeScript.';

let dir: string;
let db: SqliteDriver;
let app: Hono;
let auth: DashboardAuth;
let draftId: string;
let fts5: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-auth-'));
  const opened = openDatabase(join(dir, 't.sqlite3'));
  db = opened.db;
  fts5 = opened.fts5;
  migrate(db);
  const { artifactId } = seedSourceAndArtifact(db);
  const claim = proposeClaim(db, {
    statement:
      'Alex authored a hosting and DNS MCP server exposing roughly sixty curated tools in strict TypeScript.',
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'manual',
  });
  verifyClaim(db, { claim_id: claim.id, confirm: true });
  ensureLocalAccount(db);
  draftId = writeDraft(db, { body_text: BODY }).draft.id;
  validateDraft(db, draftId);

  auth = new DashboardAuth(PORT);
  app = buildDashboardApp({
    db,
    store: new ArtifactStore(join(dir, 'artifacts')),
    fts5: opened.fts5,
    auth,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function login(): Promise<string> {
  const res = await app.fetch(
    new Request(`http://${HOST}/api/session`, {
      method: 'POST',
      headers: { host: HOST, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: auth.launchToken }),
    }),
  );
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

// `confirm: true` is required by every state-changing route (see
// routes/types.ts). Defaulted in the helper so the assertions below are
// unchanged: the dashboard contract remains explicitly confirmed even though
// MCP now has its own separately bound confirmation contract.
async function post(path: string, cookie: string, body: Record<string, unknown> = {}) {
  return postRaw(path, cookie, { confirm: true, ...body });
}

async function postRaw(path: string, cookie: string, body: unknown) {
  return app.fetch(
    new Request(`http://${HOST}${path}`, {
      method: 'POST',
      headers: {
        host: HOST,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('publication decision confirmation', () => {
  it('refuses a grant that was not explicitly confirmed', async () => {
    const { approval } = requestApproval(db, { draft_id: draftId });
    const cookie = await login();

    const unconfirmed = await postRaw(`/api/approvals/${approval.id}/grant`, cookie, {});
    expect(unconfirmed.status).toBe(400);
    expect(getApproval(db, approval.id).state).toBe('pending');

    const confirmed = await post(`/api/approvals/${approval.id}/grant`, cookie);
    expect(confirmed.status).toBe(200);
    expect(getApproval(db, approval.id).state).toBe('granted');
  });

  it('lets MCP grant only the exact revision after an explicit bound command', async () => {
    const { approval, preview } = requestApproval(db, { draft_id: draftId });
    const tool = publishTools({ db, fts5, home: dir, actor: 'mcp_host' }).find(
      (candidate) => candidate.name === 'linkedin_approval_decide',
    );
    expect(tool).toBeDefined();

    await expect(
      tool!.handler({
        action: 'grant',
        approval_id: approval.id,
        revision_hash: preview.revision_hash,
        command: 'APPROVE SOMETHING ELSE',
        confirm: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(getApproval(db, approval.id).state).toBe('pending');

    await tool!.handler({
      action: 'grant',
      approval_id: approval.id,
      revision_hash: preview.revision_hash,
      command: `APPROVE ${approval.id} ${preview.revision_hash}`,
      confirm: true,
    } as never);
    expect(getApproval(db, approval.id).state).toBe('granted');
    expect(
      db.get(
        "SELECT actor FROM audit_events WHERE event_type = 'approval.granted' AND subject_id = ?",
        approval.id,
      ),
    ).toMatchObject({ actor: 'mcp_host' });
  });

  it('lets MCP reject or revise only after the matching explicit command', async () => {
    const decisionTool = publishTools({ db, fts5, home: dir, actor: 'mcp_host' }).find(
      (candidate) => candidate.name === 'linkedin_approval_decide',
    )!;
    const first = requestApproval(db, { draft_id: draftId }).approval;
    await decisionTool.handler({
      action: 'deny',
      approval_id: first.id,
      reason: 'The angle is not right.',
      command: `REJECT ${first.id}`,
      confirm: true,
    } as never);
    expect(getApproval(db, first.id).state).toBe('denied');

    validateDraft(db, draftId);
    const second = requestApproval(db, { draft_id: draftId }).approval;
    const result = (await decisionTool.handler({
      action: 'revise',
      approval_id: second.id,
      body_text: `${BODY} Revised after my explicit review.`,
      command: `REVISE ${second.id}`,
      confirm: true,
    } as never)) as { approval_state: string; revision_hash: string };
    expect(result.approval_state).toBe('invalidated');
    expect(result.revision_hash).not.toBe(second.revision_hash);
  });

  it('still grants through the dashboard, and the granted approval then publishes once', async () => {
    const { approval } = requestApproval(db, { draft_id: draftId });
    expect(approval.state).toBe('pending');

    // Unauthenticated grant attempt is refused.
    const anon = await app.fetch(
      new Request(`http://${HOST}/api/approvals/${approval.id}/grant`, {
        method: 'POST',
        headers: { host: HOST, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(anon.status).toBe(401);
    expect(getApproval(db, approval.id).state).toBe('pending');

    const cookie = await login();
    const granted = await post(`/api/approvals/${approval.id}/grant`, cookie);
    expect(granted.status).toBe(200);
    expect(getApproval(db, approval.id).state).toBe('granted');

    const publication = await executePublication(db, new DryRunPublisher(), {
      approval_id: approval.id,
    });
    expect(publication.outcome).toBe('succeeded');
  });

  it('shows the exact text being approved, byte-for-byte', async () => {
    requestApproval(db, { draft_id: draftId });
    const cookie = await login();
    const res = await app.fetch(
      new Request(`http://${HOST}/api/approvals`, {
        headers: { host: HOST, 'sec-fetch-site': 'same-origin', cookie },
      }),
    );
    const body = (await res.json()) as {
      approvals: Array<{ preview: { body_text: string } | null }>;
      chain: { valid: boolean };
    };
    expect(body.approvals[0]!.preview!.body_text).toBe(BODY);
    expect(body.chain.valid).toBe(true);
  });

  it('refuses to grant an approval whose draft moved on', async () => {
    const { approval } = requestApproval(db, { draft_id: draftId });
    writeDraft(db, { draft_id: draftId, body_text: `${BODY} Now with extra words.` });
    const cookie = await login();
    const res = await post(`/api/approvals/${approval.id}/grant`, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    // The edit already invalidated it; granting a dead approval is refused.
    expect(['APPROVAL_INVALIDATED', 'TERMINAL_STATE']).toContain(body.error.code);
    expect(getApproval(db, approval.id).state).toBe('invalidated');
  });

  it('cannot publish an approval that was denied', async () => {
    const { approval } = requestApproval(db, { draft_id: draftId });
    const cookie = await login();
    await post(`/api/approvals/${approval.id}/deny`, cookie, { reason: 'not now' });
    await expect(
      executePublication(db, new DryRunPublisher(), { approval_id: approval.id }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
