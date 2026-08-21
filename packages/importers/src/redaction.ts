import { createHash } from 'node:crypto';

// Ingest-time secret scrubbing. Runs on every extracted text BEFORE the row is
// written, so secrets never reach the searchable database or FTS index. The
// immutable original stays byte-identical in the artifact store (sealed,
// ACL-protected); only derivatives are scrubbed.

export interface RedactionFinding {
  type: string;
  sha8: string;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

const PATTERNS: Array<{ type: string; re: RegExp }> = [
  {
    type: 'pem_private_key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { type: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { type: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    type: 'env_secret_assignment',
    // The value alternation has to survive whitespace INSIDE the value. The
    // previous `['"]?[^\s'"]{6,}['"]?` stopped at the first space, with two
    // distinct failures:
    //   password: "correct horse battery staple"  ->  redacted only `"correct`,
    //     writing ` horse battery staple"` into extractions.text, which is
    //     FTS5-indexed and served in artifact previews;
    //   DB_PASSWORD="my secret phrase"            ->  matched NOTHING, because
    //     no 6-character run of non-space, non-quote characters exists, so
    //     contains_secrets stayed false and nothing flagged the artifact.
    // Quoted branches run to the matching quote; unquoted YAML values may also
    // contain spaces, so the last branch takes the rest of the line.
    // Over-redacting a derivative is the safe direction here: the immutable
    // original is untouched, and the KEY already had to look like a credential
    // for this pattern to fire — the line anchor plus [A-Z0-9_]* keeps it off
    // ordinary prose like "My password: is stored safely".
    re: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*[ \t]*[=:][ \t]*(?:"[^"\r\n]{3,}"|'[^'\r\n]{3,}'|[^\r\n]{4,})/gim,
  },
];

const CANDIDATE_TOKEN = /\b[A-Za-z0-9+/=_-]{40,}\b/g;
const ENTROPY_THRESHOLD = 4.5;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function marker(type: string, match: string): string {
  const sha8 = createHash('sha256').update(match, 'utf8').digest('hex').slice(0, 8);
  return `[REDACTED:${type}:${sha8}]`;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const findings: RedactionFinding[] = [];

  for (const { type, re } of PATTERNS) {
    text = text.replace(re, (match) => {
      const replacement = marker(type, match);
      findings.push({ type, sha8: replacement.split(':')[2]!.slice(0, 8) });
      return replacement;
    });
  }

  // High-entropy long tokens that survived the pattern pass. sha256 hashes and
  // git OIDs are hex (entropy ~3.9); base64-ish secrets score higher.
  text = text.replace(CANDIDATE_TOKEN, (match) => {
    if (/^[0-9a-f]+$/i.test(match)) return match; // hex digest, keep
    if (shannonEntropy(match) < ENTROPY_THRESHOLD) return match;
    const replacement = marker('high_entropy_token', match);
    findings.push({ type: 'high_entropy_token', sha8: replacement.split(':')[2]!.slice(0, 8) });
    return replacement;
  });

  return { text, findings };
}
