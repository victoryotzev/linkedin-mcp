import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import {
  contentOpportunities,
  currentRevision,
  extractHashtags,
  getDraft,
  guessLanguage,
  latestValidation,
  listCalendar,
  proposeClaim,
  upsertCalendarEntry,
  validateDraft,
  verifyClaim,
  voiceProfile,
  writeDraft,
} from '@linkedin-mcp/domain';
import { DomainError, newId } from '@linkedin-mcp/shared';
import { seedSourceAndArtifact } from '../helpers/seed.ts';

let dir: string;
let db: SqliteDriver;
let artifactId: string;

const SUPPORTED_LINE =
  'I authored a hosting and DNS MCP server exposing roughly sixty curated tools in strict TypeScript.';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-content-'));
  db = openDatabase(join(dir, 't.sqlite3')).db;
  migrate(db);
  ({ artifactId } = seedSourceAndArtifact(db));

  const verify = (statement: string) => {
    const claim = proposeClaim(db, {
      statement,
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    return verifyClaim(db, { claim_id: claim.id, confirm: true }).id;
  };
  verify(
    'Alex authored a hosting and DNS MCP server exposing roughly sixty curated tools in strict TypeScript.',
  );
  verify('Alex built a custom ERP platform with project management, budgeting and reporting.');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function seedPublished(commentary: string, postedAt: string) {
  db.run(
    `INSERT INTO published_posts (id, posted_at, commentary, char_count, hashtags_json, language_guess, artifact_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('pub'),
    postedAt,
    commentary,
    commentary.length,
    JSON.stringify(extractHashtags(commentary)),
    guessLanguage(commentary),
    artifactId,
    new Date().toISOString(),
  );
}

describe('draft lifecycle and validation', () => {
  it('validates a supported draft and promotes it to validated', () => {
    const { draft } = writeDraft(db, { body_text: SUPPORTED_LINE });
    const report = validateDraft(db, draft.id);
    expect(report.passed).toBe(true);
    expect(getDraft(db, draft.id).state).toBe('validated');
  });

  it('blocks unsupported sentences, fabricated metrics, secrets and filler language', () => {
    const { draft } = writeDraft(db, {
      body_text: [
        SUPPORTED_LINE,
        'It already serves 10,000 users across 40 countries.',
        "In today's fast-paced world this is a game-changer.",
        'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      ].join(' '),
    });
    const report = validateDraft(db, draft.id);
    expect(report.passed).toBe(false);
    const failed = new Map(report.checks.filter((c) => !c.passed).map((c) => [c.check, c]));
    expect([...failed.keys()].sort()).toEqual(
      ['fabricated_metrics', 'secret_leakage', 'unsupported_claims', 'vague_language'].sort(),
    );
    expect(failed.get('fabricated_metrics')!.offenders.join(' ')).toContain('10,000 users');
    expect(failed.get('vague_language')!.offenders).toContain('game-changer');
    expect(getDraft(db, draft.id).state).toBe('draft');
  });

  // The check used to ask only whether the digit run appeared ANYWHERE in the
  // concatenated corpus, ignoring the unit and digit boundaries — so any
  // unrelated number in any verified claim laundered a fabricated one.
  it('will not let a number from an unrelated claim back a different quantity', () => {
    const claim = proposeClaim(db, {
      statement: 'The ERP repository contains 181 test files across its suites.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });

    const { draft } = writeDraft(db, {
      body_text: `${SUPPORTED_LINE} The rollout drove 181 percent growth and reached 18 customers.`,
    });
    const report = validateDraft(db, draft.id);
    const metrics = report.checks.find((c) => c.check === 'fabricated_metrics')!;
    expect(metrics.passed).toBe(false);
    // Same digits, different unit — not backed.
    expect(metrics.offenders.join(' ')).toContain('181 percent');
    // A prefix of a backed number is not a backed number.
    expect(metrics.offenders.join(' ')).toContain('18 customers');
  });

  it('accepts a quantity whose digits AND unit both appear in a verified claim', () => {
    const claim = proposeClaim(db, {
      // The unit must be one METRIC_RE actually recognises, or this test would
      // pass because no metric was ever extracted rather than because the
      // metric was backed.
      statement: 'The Portfolio suite covers 5 projects in every release.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'parser',
    });
    verifyClaim(db, { claim_id: claim.id, confirm: true });
    const { draft } = writeDraft(db, { body_text: `${SUPPORTED_LINE} It covers 5 projects.` });
    const report = validateDraft(db, draft.id);
    expect(report.checks.find((c) => c.check === 'fabricated_metrics')!.passed).toBe(true);
  });

  it('flags near-duplicates of the member’s own published posts', () => {
    seedPublished(SUPPORTED_LINE, '2026-01-01 10:00:00');
    const { draft } = writeDraft(db, { body_text: SUPPORTED_LINE });
    const report = validateDraft(db, draft.id);
    const repetition = report.checks.find((c) => c.check === 'repetition')!;
    expect(repetition.passed).toBe(false);
    expect(repetition.offenders[0]).toContain('published 2026-01-01');
  });

  it('marks an earlier validation stale once the draft is revised', () => {
    const { draft } = writeDraft(db, { body_text: SUPPORTED_LINE });
    validateDraft(db, draft.id);
    const before = latestValidation(db, draft.id)!;

    writeDraft(db, {
      draft_id: draft.id,
      body_text: `${SUPPORTED_LINE} It also ships automated tests.`,
    });
    const revision = currentRevision(db, draft.id);
    expect(revision.revision).toBe(2);
    expect(before.revision_hash).not.toBe(revision.revision_hash);
    // Editing always returns the draft to 'draft' so a stale pass cannot ride along.
    expect(getDraft(db, draft.id).state).toBe('draft');
  });
});

describe('opportunities, voice profile and calendar', () => {
  it('ranks unpublished claims above ones already covered', () => {
    seedPublished(SUPPORTED_LINE, '2026-01-01 10:00:00');
    const ideas = contentOpportunities(db, {});
    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.statement).toContain('ERP platform');
    expect(ideas[0]!.novelty).toBeGreaterThan(ideas[1]!.novelty);
    expect(ideas[1]!.closest_prior).toContain('published');
  });

  it('supports ranked opportunity windows beyond the first result page', () => {
    const first = contentOpportunities(db, { limit: 1 });
    const second = contentOpportunities(db, { offset: 1, limit: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.claim_id).not.toBe(first[0]!.claim_id);
  });

  it('describes the published history without inventing a tone', () => {
    seedPublished('Short post about #mcp tooling.', '2026-01-01 10:00:00');
    seedPublished(
      'Малко по-дълъг пост на български за енергийна ефективност.',
      '2026-02-01 10:00:00',
    );
    const profile = voiceProfile(db);
    expect(profile.posts).toBe(2);
    expect(profile.language_mix['bg']).toBe(1);
    expect(profile.top_hashtags[0]!.tag).toBe('#mcp');
    expect(profile.first_post).toBe('2026-01-01 10:00:00');
  });

  it('stores calendar entries as inert planning metadata', () => {
    const entry = upsertCalendarEntry(db, { intended_date: '2026-09-01', note: 'thesis post' });
    expect(entry.status).toBe('planned');
    expect(listCalendar(db)).toHaveLength(1);
    // Nothing in the system reads intended_date to trigger anything: the only
    // publication path is an explicit human approval.
    expect(db.get('SELECT COUNT(*) AS n FROM post_drafts')!['n']).toBe(0);
  });

  it('preserves omitted calendar fields, permits explicit clearing, and rejects unknown ids', () => {
    const entry = upsertCalendarEntry(db, {
      intended_date: '2026-09-01',
      status: 'drafted',
      note: 'keep me',
    });
    const moved = upsertCalendarEntry(db, { id: entry.id, intended_date: '2026-09-02' });
    expect(moved.status).toBe('drafted');
    expect(moved.note).toBe('keep me');

    const cleared = upsertCalendarEntry(db, { id: entry.id, note: null });
    expect(cleared.note).toBeNull();
    expect(cleared.intended_date).toBe('2026-09-02');
    expect(() => upsertCalendarEntry(db, { id: 'cal_missing', note: 'no-op' })).toThrowError(
      DomainError,
    );
  });

  it('rejects impossible dates, invalid statuses, and dangling calendar references', () => {
    expect(() => upsertCalendarEntry(db, { intended_date: '2026-02-31' })).toThrowError(
      /not a real calendar date/,
    );
    expect(() =>
      upsertCalendarEntry(db, {
        intended_date: '2026-09-01',
        status: 'queued' as never,
      }),
    ).toThrowError(/unsupported calendar status/);
    expect(() =>
      upsertCalendarEntry(db, { intended_date: '2026-09-01', draft_id: 'drf_missing' }),
    ).toThrowError(/draft drf_missing not found/);
    expect(() =>
      upsertCalendarEntry(db, { intended_date: '2026-09-01', pillar_id: 'pil_missing' }),
    ).toThrowError(/pillar pil_missing not found/);
  });
});
