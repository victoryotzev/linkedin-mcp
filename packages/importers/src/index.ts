export { extractDocxText, type DocxExtractResult } from './docx.ts';
export {
  assertAcceptableShape,
  assertContained,
  canonicalizePath,
  hostPathPlatform,
  isContainedIn,
  isReparsePoint,
  type PathPlatform,
} from './pathGuard.ts';
export { redactSecrets, type RedactionFinding, type RedactionResult } from './redaction.ts';
export { DEFAULT_CSV_LIMITS, parseCsv, type CsvLimits } from './csv.ts';
export {
  DEFAULT_ZIP_LIMITS,
  readZipEntries,
  sanitizeEntryName,
  type ZipEntryData,
  type ZipLimits,
} from './zip.ts';
export { extractPdfText, type PdfExtractResult } from './pdf.ts';
export {
  MAX_EXTRACTION_TEXT,
  extractFromBytes,
  mimeFor,
  type ExtractionOutcome,
} from './extract.ts';
export { scanRepo, type RepoScanResult } from './repoScan.ts';

// Default skip-list for LinkedIn export archives: third-party PII, security
// history and ad/inference profiling are never imported unless the user
// explicitly overrides via the allowlisted 'importer.pii_skiplist' setting.
// Exact file names (case-insensitive).
export const DEFAULT_PII_SKIPLIST = [
  'messages.csv',
  'Connections.csv',
  'Invitations.csv',
  'PhoneNumbers.csv',
  'Whatsapp Phone Numbers.csv',
  'Email Addresses.csv',
  'guide_messages.csv',
  'learning_coach_messages.csv',
  'learning_role_play_messages.csv',
  'LearningCoachMessages.csv',
  'Registration.csv',
  'Ad_Targeting.csv',
  'Logins.csv',
  'Security Challenges.csv',
  'Ads Clicked.csv',
  'LAN Ads Engagement.csv',
  'Inferences_about_you.csv',
  'Inferred Credibility Scores.csv',
  'Account Status History.csv',
  'Receipts.csv',
];

// The Complete export suffixes several files with the member id
// (Votes_836880749.csv), so name matching alone is not enough. These patterns
// cover the sensitive families regardless of suffix.
export const DEFAULT_PII_SKIP_PATTERNS: readonly RegExp[] = [
  /^logins/i,
  /^security[ _-]?challenges/i,
  /^ads?[ _-]?clicked/i,
  /^inference/i,
  /^inferred/i,
  /^rich[ _-]?media/i,
  /^saved[ _-]?items/i,
  /^member[ _-]?follows/i,
  /^hashtag[ _-]?follows/i,
  /^votes/i,
  /^reactions/i,
  /^receipts/i,
  /^trusted[ _-]?graph/i,
  /^phone/i,
  /^email/i,
  /message/i,
  /^connections/i,
  /^invitations/i,
];

export function isSensitiveExportFile(
  fileName: string,
  skiplist: Iterable<string> = DEFAULT_PII_SKIPLIST,
  patterns: readonly RegExp[] = DEFAULT_PII_SKIP_PATTERNS,
): boolean {
  const base = (fileName.split('/').pop() ?? fileName).toLowerCase();
  for (const entry of skiplist) {
    if (entry.toLowerCase() === base) return true;
  }
  return patterns.some((re) => re.test(base));
}
