import { createHash } from 'node:crypto';
import { withWriteTx, type SqliteDriver } from '@linkedin-mcp/db';
import { newId } from '@linkedin-mcp/shared';

// Sentence-level evidence coverage: deterministic, explainable token-overlap
// scoring against VERIFIED claims only. This is a screening instrument — the
// scores are transparent ratios, not fake precision; validation (P6) treats
// 'unsupported' as a hard block for drafts.

export interface SentenceCoverage {
  index: number;
  text: string;
  status: 'supported' | 'partial' | 'unsupported';
  claim_ids: string[];
  best_score: number;
}

export interface CoverageReport {
  id: string;
  subject: 'freeform' | 'draft' | 'patch';
  subject_ref: string | null;
  text_sha256: string;
  corpus_fingerprint: string;
  sentences: SentenceCoverage[];
  supported_count: number;
  total_count: number;
  created_at: string;
}

// A report is only reusable when BOTH the text and the verified-claim corpus
// are unchanged. Verifying, rejecting or expiring a claim changes this
// fingerprint, so cached reports never outlive the evidence they scored.
export function corpusFingerprint(db: SqliteDriver): string {
  const rows = db.all("SELECT id, statement_hash FROM claims WHERE state = 'verified' ORDER BY id");
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(`${String(row['id'])}:${String(row['statement_hash'])}\n`);
  }
  return `${rows.length}-${hash.digest('hex').slice(0, 32)}`;
}

const STOPWORDS = new Set(
  'a an the and or but of in on at to for with from by as is are was were be been being this that these those it its i my we our you your he she they them his her their has have had do does did not no yes if then than so very can could will would should may might'.split(
    ' ',
  ),
);

const SUPPORTED_THRESHOLD = 0.5;
const PARTIAL_THRESHOLD = 0.25;

export function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function scoreAgainst(sentence: Set<string>, claim: Set<string>): number {
  if (sentence.size === 0) return 0;
  let shared = 0;
  for (const token of sentence) {
    if (claim.has(token)) shared += 1;
  }
  return shared / sentence.size;
}

export function checkCoverage(
  db: SqliteDriver,
  input: { text: string; subject?: 'freeform' | 'draft' | 'patch'; subject_ref?: string },
): CoverageReport {
  const textSha = createHash('sha256').update(input.text, 'utf8').digest('hex');
  const fingerprint = corpusFingerprint(db);

  // Content-addressed over (text, verified-claim corpus): identical inputs
  // reuse the stored report; a changed corpus forces a rescore.
  const existing = db.get(
    'SELECT * FROM coverage_reports WHERE text_sha256 = ? AND corpus_fingerprint = ?',
    textSha,
    fingerprint,
  );
  if (existing) return rowToReport(existing);

  const verified = db.all("SELECT id, statement FROM claims WHERE state = 'verified'");
  const claimTokens = verified.map((row) => ({
    id: String(row['id']),
    tokens: significantTokens(String(row['statement'])),
  }));

  const sentences: SentenceCoverage[] = splitSentences(input.text).map((sentence, index) => {
    const tokens = significantTokens(sentence);
    const scored = claimTokens
      .map((c) => ({ id: c.id, score: scoreAgainst(tokens, c.tokens) }))
      .filter((s) => s.score >= PARTIAL_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const best = scored[0]?.score ?? 0;
    return {
      index,
      text: sentence,
      status:
        best >= SUPPORTED_THRESHOLD
          ? 'supported'
          : best >= PARTIAL_THRESHOLD
            ? 'partial'
            : 'unsupported',
      claim_ids: scored.map((s) => s.id),
      best_score: Number(best.toFixed(3)),
    };
  });

  const report: CoverageReport = {
    id: newId('cov'),
    subject: input.subject ?? 'freeform',
    subject_ref: input.subject_ref ?? null,
    text_sha256: textSha,
    corpus_fingerprint: fingerprint,
    sentences,
    supported_count: sentences.filter((s) => s.status === 'supported').length,
    total_count: sentences.length,
    created_at: new Date().toISOString(),
  };
  return withWriteTx(db, () => {
    // ON CONFLICT DO NOTHING, then re-select the winner. The cache lookup above
    // runs outside this transaction — deliberately, so scoring does not hold
    // the write lock — which leaves a window where another process stores the
    // same (text, corpus) pair first. That used to surface as a raw SQLite
    // UNIQUE error from idx_coverage_text_corpus; now the loser simply adopts
    // the winner's report, which is byte-identical by construction.
    db.run(
      `INSERT INTO coverage_reports (id, subject, subject_ref, text_sha256, corpus_fingerprint, sentences_json, supported_count, total_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (text_sha256, corpus_fingerprint) DO NOTHING`,
      report.id,
      report.subject,
      report.subject_ref,
      report.text_sha256,
      report.corpus_fingerprint,
      JSON.stringify(report.sentences),
      report.supported_count,
      report.total_count,
      report.created_at,
    );
    const stored = db.get(
      'SELECT * FROM coverage_reports WHERE text_sha256 = ? AND corpus_fingerprint = ?',
      report.text_sha256,
      report.corpus_fingerprint,
    );
    // Return what is actually in the table, so the id the caller sees always
    // resolves.
    return stored ? rowToReport(stored) : report;
  });
}

function rowToReport(row: Record<string, unknown>): CoverageReport {
  return {
    id: String(row['id']),
    subject: String(row['subject']) as CoverageReport['subject'],
    subject_ref: (row['subject_ref'] as string | null) ?? null,
    text_sha256: String(row['text_sha256']),
    corpus_fingerprint: String(row['corpus_fingerprint']),
    sentences: JSON.parse(String(row['sentences_json'])) as SentenceCoverage[],
    supported_count: Number(row['supported_count']),
    total_count: Number(row['total_count']),
    created_at: String(row['created_at']),
  };
}
