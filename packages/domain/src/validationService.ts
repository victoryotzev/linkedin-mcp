import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { redactSecrets } from '@linkedin-mcp/importers';
import { newId } from '@linkedin-mcp/shared';
import {
  checkCoverage,
  corpusFingerprint,
  significantTokens,
  splitSentences,
} from './coverageService.ts';
import { currentRevision } from './draftService.ts';
import { getSettingOrDefault } from './settingsService.ts';

// Deterministic gates a draft must clear before it can be approved. Every
// check names its offending text so the fix is obvious; none of them depend on
// a language model.

export interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
  offenders: string[];
}

export interface ValidationReport {
  id: string;
  draft_id: string;
  revision_hash: string;
  passed: boolean;
  checks: CheckResult[];
  created_at: string;
  /**
   * The verified-claim corpus this report was computed against. The report's
   * central check is a statement about that corpus, so the text hash alone
   * cannot say whether the report is still true. Null on rows written before
   * migration 014, and treated as stale.
   */
  corpus_fingerprint: string | null;
}

const DEFAULT_POST_LIMIT = 3000;

// Phrases that read as machine-generated filler. Kept small and specific: a
// long list would flag ordinary writing.
const VAGUE_PHRASES = [
  "in today's fast-paced world",
  'in the ever-evolving landscape',
  'game-changer',
  'game changer',
  'delve into',
  'unlock the power',
  'harness the power',
  'take it to the next level',
  'i am thrilled to announce',
  'i am excited to share that',
  'revolutionize',
  'cutting-edge solutions',
  'seamlessly integrate',
  'leverage synergies',
  'at the end of the day',
];

const METRIC_RE =
  /\b\d[\d,.]*\s*(?:%|percent|x\b|k\b|m\b|users?|customers?|clients?|downloads?|stars?|hours?|days?|weeks?|months?|years?|people|developers?|companies|projects?|times)\b/gi;

// "60 tools", "60  Tools" and "60tools" are the same claim; "600 tools" is not.
// Trailing plural 's' is dropped so a claim's singular unit still backs a
// drafted plural.
function normalizeMetric(metric: string): string {
  const [, digits = '', unit = ''] = /^(\d[\d,.]*?)[.,]?\s*(.*)$/.exec(metric.trim()) ?? [];
  return `${digits.replace(/,/g, '')}|${unit.toLowerCase().replace(/s$/, '')}`;
}

export function validateDraft(db: SqliteDriver, draftId: string): ValidationReport {
  const revision = currentRevision(db, draftId);
  const body = revision.body_text;
  const checks: CheckResult[] = [];

  // 1. Character limit (config; LinkedIn's own limit is unverified first-party).
  const limits = getSettingOrDefault(db, 'field_limits', {});
  const limit = limits['post'] ?? DEFAULT_POST_LIMIT;
  checks.push({
    check: 'char_limit',
    passed: body.length <= limit,
    detail: `${body.length} of ${limit} characters`,
    offenders: [],
  });

  // 2. Evidence coverage — unsupported sentences are the hard blocker.
  const coverage = checkCoverage(db, { text: body, subject: 'draft', subject_ref: draftId });
  const unsupported = coverage.sentences.filter((s) => s.status === 'unsupported');
  checks.push({
    check: 'unsupported_claims',
    passed: unsupported.length === 0,
    detail: `${coverage.supported_count}/${coverage.total_count} sentences backed by verified claims`,
    offenders: unsupported.map((s) => s.text),
  });

  // 3. Secret leakage — the same scanner that runs on ingest.
  const redaction = redactSecrets(body);
  checks.push({
    check: 'secret_leakage',
    passed: redaction.findings.length === 0,
    detail:
      redaction.findings.length === 0
        ? 'no credential-shaped strings found'
        : `${redaction.findings.length} credential-shaped string(s) found`,
    offenders: redaction.findings.map((f) => `${f.type}:${f.sha8}`),
  });

  // 4. Fabricated metrics — numbers with units that no verified claim carries.
  //
  // The unit has to match, not just the digits. Comparing the bare digit run
  // against the whole corpus concatenated together meant any unrelated number
  // in any verified claim laundered a fabricated metric: a claim saying "181
  // test files" let a draft assert "181% growth", and "60 tools" backed
  // "60,000 users" because `includes('60')` is true of "600" too.
  const metrics = [...new Set(body.match(METRIC_RE) ?? [])];
  const verifiedMetrics = new Set(
    db
      .all("SELECT statement FROM claims WHERE state = 'verified'")
      .flatMap((r) => String(r['statement']).match(METRIC_RE) ?? [])
      .map(normalizeMetric),
  );
  const unbackedMetrics = metrics.filter((m) => !verifiedMetrics.has(normalizeMetric(m)));
  checks.push({
    check: 'fabricated_metrics',
    passed: unbackedMetrics.length === 0,
    detail:
      unbackedMetrics.length === 0
        ? 'every quantity appears in a verified claim'
        : `${unbackedMetrics.length} quantity/quantities not found in any verified claim`,
    offenders: unbackedMetrics,
  });

  // 5. Repetition against the member's own published history and other drafts.
  const bodyTokens = significantTokens(body);
  const repeats: string[] = [];
  for (const row of db.all('SELECT id, posted_at, commentary FROM published_posts')) {
    const overlap = jaccard(bodyTokens, significantTokens(String(row['commentary'])));
    if (overlap >= 0.5)
      repeats.push(`published ${String(row['posted_at'])} (${Math.round(overlap * 100)}% overlap)`);
  }
  for (const row of db.all(
    'SELECT dr.draft_id, dr.body_text FROM draft_revisions dr JOIN post_drafts d ON d.id = dr.draft_id AND d.current_revision = dr.revision WHERE dr.draft_id != ?',
    draftId,
  )) {
    const overlap = jaccard(bodyTokens, significantTokens(String(row['body_text'])));
    if (overlap >= 0.6)
      repeats.push(`draft ${String(row['draft_id'])} (${Math.round(overlap * 100)}% overlap)`);
  }
  checks.push({
    check: 'repetition',
    passed: repeats.length === 0,
    detail:
      repeats.length === 0
        ? 'no near-duplicate of an earlier post or draft'
        : `${repeats.length} near-duplicate(s)`,
    offenders: repeats,
  });

  // 6. Vague AI-sounding language.
  const lower = body.toLowerCase();
  const vague = VAGUE_PHRASES.filter((p) => lower.includes(p));
  checks.push({
    check: 'vague_language',
    passed: vague.length === 0,
    detail: vague.length === 0 ? 'no filler phrases detected' : `${vague.length} filler phrase(s)`,
    offenders: vague,
  });

  // 7. Link shape — LinkedIn strips nothing, but broken/relative links embarrass.
  const badLinks = (body.match(/\bhttps?:\/\/\S+/gi) ?? []).filter((url) => {
    try {
      const parsed = new URL(url.replace(/[.,;:)]+$/, ''));
      return parsed.protocol !== 'https:' && parsed.protocol !== 'http:';
    } catch {
      return true;
    }
  });
  checks.push({
    check: 'link_format',
    passed: badLinks.length === 0,
    detail: badLinks.length === 0 ? 'links parse cleanly' : `${badLinks.length} malformed link(s)`,
    offenders: badLinks,
  });

  const passed = checks.every((c) => c.passed);
  const report: ValidationReport = {
    id: newId('val'),
    draft_id: draftId,
    revision_hash: revision.revision_hash,
    passed,
    checks,
    created_at: new Date().toISOString(),
    corpus_fingerprint: corpusFingerprint(db),
  };

  withWriteTx(db, () => {
    db.run(
      `INSERT INTO validation_reports (id, draft_id, revision_hash, passed, checks_json, created_at, corpus_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      report.id,
      report.draft_id,
      report.revision_hash,
      passed ? 1 : 0,
      JSON.stringify(report.checks),
      report.created_at,
      report.corpus_fingerprint,
    );
    // Conditional on the revision that was ACTUALLY validated. `draft` was read
    // ~150 statements ago, before the scoring work, so a revision appended in
    // the meantime would otherwise be marked 'validated' on the strength of a
    // report describing older text. The WHERE clause makes that a no-op instead.
    if (passed) {
      db.run(
        `UPDATE post_drafts SET state = 'validated', updated_at = ?
         WHERE id = ? AND state = 'draft' AND current_revision_hash = ?`,
        new Date().toISOString(),
        draftId,
        revision.revision_hash,
      );
    }
  });
  return report;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function latestValidation(db: SqliteDriver, draftId: string): ValidationReport | null {
  const row = db.get(
    'SELECT * FROM validation_reports WHERE draft_id = ? ORDER BY created_at DESC, rowid DESC',
    draftId,
  );
  if (!row) return null;
  return {
    id: String(row['id']),
    draft_id: String(row['draft_id']),
    revision_hash: String(row['revision_hash']),
    passed: Number(row['passed']) === 1,
    checks: JSON.parse(String(row['checks_json'])) as CheckResult[],
    created_at: String(row['created_at']),
    corpus_fingerprint: (row['corpus_fingerprint'] as string | null) ?? null,
  };
}

export { splitSentences };
