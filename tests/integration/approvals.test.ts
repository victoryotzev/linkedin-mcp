import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  appendAuditEvent,
  approvalPreview,
  denyApproval,
  ensureLocalAccount,
  executePublication,
  getApproval,
  getDraft,
  grantApproval,
  listPublications,
  proposeClaim,
  queryAuditEvents,
  reconcilePublication,
  rejectClaim,
  requestApproval,
  validateDraft,
  verifyAuditChain,
  verifyClaim,
  writeDraft,
} from '@linkedin-mcp/domain';
import { DryRunPublisher, type PublishOutcome, type Publisher } from '@linkedin-mcp/linkedin';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

const execFileAsync = promisify(execFile);

const BODY =
  'I authored a hosting and DNS MCP server exposing roughly sixty curated tools in strict TypeScript.';

let dir: string;
let dbPath: string;
let db: SqliteDriver;
let artifactId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-apv-'));
  dbPath = join(dir, 't.sqlite3');
  db = openDatabase(dbPath).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));
  const claim = proposeClaim(db, {
    statement:
      'Alex authored a hosting and DNS MCP server exposing roughly sixty curated tools in strict TypeScript.',
    evidence: [{ artifact_id: artifactId, location: {} }],
    method: 'manual',
  });
  verifyClaim(db, { claim_id: claim.id, confirm: true });
  ensureLocalAccount(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function validatedDraft(): string {
  const { draft } = writeDraft(db, { body_text: BODY });
  const report = validateDraft(db, draft.id);
  expect(report.passed).toBe(true);
  return draft.id;
}

class ScriptedPublisher implements Publisher {
  readonly name = 'dry_run' as const;
  calls = 0;
  constructor(private readonly outcome: PublishOutcome | 'throw') {}
  async publish(): Promise<PublishOutcome> {
    this.calls += 1;
    if (this.outcome === 'throw') throw new Error('socket hang up');
    return this.outcome;
  }
}

// A validation report used to be bound to the TEXT only. Its central check —
// unsupported_claims — is a statement about the verified-claim corpus, which
// moves independently of the draft, so a member could reject the sole backing
// claim as false and still open the human approval gate on the cached pass.
describe('validation is bound to the evidence, not just the text', () => {
  it('refuses approval after the backing claim is rejected, without the draft changing', () => {
    const draftId = validatedDraft();
    const claim = db.get("SELECT id FROM claims WHERE state = 'verified'")!;
    rejectClaim(db, {
      claim_id: String(claim['id']),
      reason: 'turned out to be false',
      confirm: true,
      reviewer: 'test',
    });

    try {
      requestApproval(db, { draft_id: draftId });
      expect.unreachable('approval must not be requestable on withdrawn evidence');
    } catch (err) {
      expect((err as DomainError).code).toBe('EVIDENCE_NOT_VERIFIED');
      expect((err as DomainError).blockers).toContain('validation_corpus_stale');
    }
  });

  it('re-validating after a corpus change restores the gate', () => {
    const draftId = validatedDraft();
    // Adding an unrelated verified claim also moves the fingerprint.
    const extra = proposeClaim(db, {
      statement: 'An unrelated but verified statement about the portfolio site.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(db, { claim_id: extra.id, confirm: true });
    expect(() => requestApproval(db, { draft_id: draftId })).toThrowError(DomainError);

    expect(validateDraft(db, draftId).passed).toBe(true);
    expect(requestApproval(db, { draft_id: draftId }).approval.state).toBe('pending');
  });
});

describe('audit chain', () => {
  it('pages audit events with a stable descending offset', () => {
    appendAuditEvent(db, { event_type: 'a', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'b', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'c', actor: 'system', subject_type: 'test' });
    expect(queryAuditEvents(db, { limit: 2 }).map((event) => event.event_type)).toEqual(['c', 'b']);
    expect(queryAuditEvents(db, { limit: 2, offset: 2 }).map((event) => event.event_type)).toEqual([
      'a',
    ]);
  });

  it('verifies a clean chain and detects edited entries', () => {
    appendAuditEvent(db, { event_type: 'test.one', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'test.two', actor: 'system', subject_type: 'test' });
    expect(verifyAuditChain(db).valid).toBe(true);

    db.run('UPDATE audit_events SET payload_json = \'{"tampered":true}\' WHERE seq = 1');
    const status = verifyAuditChain(db);
    expect(status.valid).toBe(false);
    expect(status.broken_at_seq).toBe(1);
    expect(status.reason).toContain('edited');
  });

  it('detects removed entries', () => {
    appendAuditEvent(db, { event_type: 'a', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'b', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'c', actor: 'system', subject_type: 'test' });
    db.run('DELETE FROM audit_events WHERE seq = 2');
    const status = verifyAuditChain(db);
    expect(status.valid).toBe(false);
    expect(status.broken_at_seq).toBe(3);
  });

  // Deleting a MIDDLE entry was already caught, which is exactly what made the
  // gap easy to miss: the newest entries — the ones describing what just
  // happened — could be deleted and the chain still reported itself intact.
  it('detects a truncated tail', () => {
    appendAuditEvent(db, { event_type: 'a', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'b', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'c', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'd', actor: 'system', subject_type: 'test' });
    expect(verifyAuditChain(db).valid).toBe(true);

    db.run('DELETE FROM audit_events WHERE seq >= 3');
    const status = verifyAuditChain(db);
    expect(status.valid).toBe(false);
    expect(status.reason).toContain('newest 2');
  });

  it('detects deletion of the entire log', () => {
    appendAuditEvent(db, { event_type: 'a', actor: 'system', subject_type: 'test' });
    appendAuditEvent(db, { event_type: 'b', actor: 'system', subject_type: 'test' });
    db.run('DELETE FROM audit_events');
    // Without an anchor this re-chains cleanly from genesis and looks pristine.
    expect(verifyAuditChain(db).valid).toBe(false);
  });

  it('detects entries inserted outside the append path', () => {
    appendAuditEvent(db, { event_type: 'a', actor: 'system', subject_type: 'test' });
    const head = db.get('SELECT content_hash FROM audit_events ORDER BY seq DESC')!;
    db.run(
      `INSERT INTO audit_events (event_type, actor, subject_type, subject_id, payload_json, prev_hash, content_hash, created_at)
       VALUES ('forged', 'system', 'test', NULL, '{}', ?, 'deadbeef', ?)`,
      String(head['content_hash']),
      new Date().toISOString(),
    );
    const status = verifyAuditChain(db);
    expect(status.valid).toBe(false);
  });

  it('detects removal of the anchor itself', () => {
    appendAuditEvent(db, { event_type: 'a', actor: 'system', subject_type: 'test' });
    db.run("DELETE FROM settings WHERE key = 'audit.head'");
    const status = verifyAuditChain(db);
    expect(status.valid).toBe(false);
    expect(status.head_anchored).toBe(false);
  });

  it('refuses to grant an approval while the chain is broken', () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    db.run("UPDATE audit_events SET payload_json = '{}' WHERE seq = 1");
    try {
      grantApproval(db, approval.id);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('INTEGRITY_ERROR');
    }
  });
});

describe('approval lifecycle', () => {
  it('requires a passing validation of the current revision', () => {
    const { draft } = writeDraft(db, {
      body_text: 'Unvalidated text about nothing in particular.',
    });
    try {
      requestApproval(db, { draft_id: draft.id });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('EVIDENCE_NOT_VERIFIED');
    }
  });

  it('cannot be executed while merely pending — granting is a separate act', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    expect(approval.state).toBe('pending');
    try {
      await executePublication(db, new DryRunPublisher(), { approval_id: approval.id });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('APPROVAL_INVALIDATED');
    }
  });

  it('is invalidated the moment the draft is edited', () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);

    writeDraft(db, { draft_id: draftId, body_text: `${BODY} It also ships automated tests.` });
    const after = getApproval(db, approval.id);
    expect(after.state).toBe('invalidated');
    expect(after.invalidated_by).toContain('revised');
  });

  it('refuses a mismatched account', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);
    try {
      await executePublication(db, new DryRunPublisher(), {
        approval_id: approval.id,
        account_id: 'acc_SOMEONE_ELSE',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as DomainError).code).toBe('ACCOUNT_MISMATCH');
    }
  });

  // The preview is what a human reads before granting. It used to load the
  // CURRENT revision while labelling it with the approval's BOUND hash, so the
  // text on screen could be bytes the approval does not authorise — precisely
  // the substitution the revision binding exists to prevent.
  it('previews the bound revision, not whatever the draft says now', () => {
    const draftId = validatedDraft();
    const { approval, preview } = requestApproval(db, { draft_id: draftId });
    expect(preview.body_text).toBe(BODY);
    expect(preview.revision_is_current).toBe(true);

    const REWRITTEN = `${BODY} An entirely different second sentence was appended later.`;
    writeDraft(db, { draft_id: draftId, body_text: REWRITTEN });

    const after = approvalPreview(db, approval.id);
    expect(after.revision_hash).toBe(approval.revision_hash);
    expect(after.body_text).toBe(BODY);
    expect(after.body_text).not.toContain('entirely different');
    expect(after.char_count).toBe(BODY.length);
    expect(after.revision_is_current).toBe(false);
  });

  it('denies cleanly', () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    expect(denyApproval(db, approval.id, 'wrong angle').state).toBe('denied');
  });
});

describe('publication', () => {
  it('publishes once through the dry-run adapter and marks the draft published', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);

    const publication = await executePublication(db, new DryRunPublisher(), {
      approval_id: approval.id,
    });
    expect(publication.outcome).toBe('succeeded');
    expect(publication.linkedin_post_urn).toContain('dryrun');
    expect(getDraft(db, draftId).state).toBe('published');
    expect(getApproval(db, approval.id).state).toBe('consumed');
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it('never re-sends on replay of the same approval', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);
    const publisher = new ScriptedPublisher({ status: 'succeeded', post_urn: 'urn:li:share:1' });

    const first = await executePublication(db, publisher, { approval_id: approval.id });
    const second = await executePublication(db, publisher, { approval_id: approval.id });
    expect(second.id).toBe(first.id);
    expect(publisher.calls).toBe(1);
    expect(listPublications(db)).toHaveLength(1);
  });

  it('records a lost response as ambiguous and refuses to retry without a fresh approval', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);
    const publisher = new ScriptedPublisher('throw');

    const publication = await executePublication(db, publisher, { approval_id: approval.id });
    expect(publication.outcome).toBe('ambiguous');
    expect(getApproval(db, approval.id).state).toBe('consumed');
    expect(publisher.calls).toBe(1);

    // Replay hits the idempotency record, not the network.
    await executePublication(db, publisher, { approval_id: approval.id });
    expect(publisher.calls).toBe(1);

    // Reconciliation is a human attestation.
    expect(() =>
      reconcilePublication(db, {
        publication_id: publication.id,
        method: 'manual_attestation',
        confirm: false,
        actor: 'mcp_host',
        found: true,
      }),
    ).toThrowError(DomainError);
    const reconciled = reconcilePublication(db, {
      publication_id: publication.id,
      method: 'manual_attestation',
      confirm: true,
      actor: 'dashboard',
      found: true,
      post_url: 'https://www.linkedin.com/feed/update/urn:li:share:123/',
    });
    expect(reconciled.outcome).toBe('reconciled_success');
    expect(getDraft(db, draftId).state).toBe('published');
  });

  it('rejects a non-LinkedIn reconciliation URL', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);
    const publication = await executePublication(db, new ScriptedPublisher('throw'), {
      approval_id: approval.id,
    });
    expect(() =>
      reconcilePublication(db, {
        publication_id: publication.id,
        method: 'manual_attestation',
        confirm: true,
        actor: 'dashboard',
        found: true,
        post_url: 'https://evil.example/post/1',
      }),
    ).toThrowError(DomainError);
  });

  // PR5 acceptance criterion: two processes, one approval, N racers, exactly
  // one publication.
  //
  // The previous version used two connections inside ONE process and called
  // itself concurrent. It was not: the driver is synchronous, so the first call
  // finished entirely before the second began.
  //
  // Worth being precise about what this DOES prove, because it is not what the
  // old comment claimed. Mutation-testing it (dropping the conditional UPDATE's
  // WHERE clause and disabling its changes check) does NOT make it fail — and
  // that is correct behaviour, not a weak test. BEGIN IMMEDIATE serialises
  // writers, so two processes can never sit between assertApprovalUsable and
  // the consume at the same time; the loser enters the transaction afterwards,
  // re-reads state = 'consumed' and is refused there. The conditional UPDATE is
  // defence in depth behind that, and no test can isolate it. The hard backstop
  // is the database itself — see the UNIQUE-constraint test below.
  //
  // What this test does prove, across four real OS processes: the post goes out
  // exactly once, the approval is consumed once, and the audit chain survives.
  it('lets exactly one of four racing processes publish a single approval', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);
    db.close();

    const goFile = join(dir, 'go');
    const child = fileURLToPath(new URL('../helpers/approval-race-child.ts', import.meta.url));
    const racers = [0, 1, 2, 3].map(() =>
      execFileAsync(process.execPath, ['--import', 'tsx', child, dbPath, approval.id, goFile], {
        timeout: 120_000,
      }),
    );
    // Give every racer time to boot and reach the barrier, then release them
    // together so they collide inside the transaction.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(goFile, 'go');
    const settled = await Promise.all(racers);
    const results = settled.map((r) => JSON.parse(r.stdout) as Record<string, unknown>);

    db = openDatabase(dbPath).db;

    // The invariant is not "three racers fail" — a racer that arrives after the
    // publication row exists legitimately replays it through the idempotency
    // short-circuit. The invariant is that the post went out exactly once.
    const publications = listPublications(db);
    expect(publications).toHaveLength(1);
    expect(
      new Set(results.filter((r) => r.ok).map((r) => r.publication_id)).size,
    ).toBeLessThanOrEqual(1);
    expect(getApproval(db, approval.id).state).toBe('consumed');
    expect(getDraft(db, draftId).state).toBe('published');
    expect(verifyAuditChain(db).valid).toBe(true);

    // Whatever did not succeed must have been refused for the right reason.
    //
    // Three shapes are legitimate. Two are the guards doing their job: the
    // approval was already consumed, or the revision moved underneath it. The
    // third is a racer that never obtained the write lock at all — withWriteTx
    // retries a bounded number of times and then gives up, which is correct
    // fail-closed behaviour under contention and surfaces as a plain SQLITE_BUSY
    // rather than a DomainError. It says nothing about the invariant, which is
    // asserted above: the post went out exactly once.
    for (const r of results.filter((x) => !x.ok)) {
      if (r.code === 'UNKNOWN') {
        expect(String(r.message)).toMatch(/database is locked|SQLITE_BUSY|retries exhausted/i);
        continue;
      }
      expect(['APPROVAL_INVALIDATED', 'TERMINAL_STATE']).toContain(r.code);
    }
  }, 180_000);

  // The database-level backstop that survives any application-logic mistake:
  // even if every guard in publicationService were removed, a second
  // publication for the same approval cannot be stored.
  it('cannot store two publications for one approval, whatever the code does', async () => {
    const draftId = validatedDraft();
    const { approval } = requestApproval(db, { draft_id: draftId });
    grantApproval(db, approval.id);
    const publication = await executePublication(db, new DryRunPublisher(), {
      approval_id: approval.id,
    });

    const row = db.get('SELECT * FROM publications WHERE id = ?', publication.id)!;
    expect(() =>
      db.run(
        `INSERT INTO publications (id, draft_id, revision_hash, approval_id, idempotency_key, request_hash, adapter, outcome, attempted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        newId('pub'),
        String(row['draft_id']),
        String(row['revision_hash']),
        String(row['approval_id']),
        String(row['idempotency_key']),
        String(row['request_hash']),
        'dry_run',
        new Date().toISOString(),
      ),
    ).toThrowError(/UNIQUE/i);
    expect(listPublications(db)).toHaveLength(1);
  });
});
