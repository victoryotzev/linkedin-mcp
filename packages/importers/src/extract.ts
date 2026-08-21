import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCsv } from './csv.ts';
import { extractDocxText } from './docx.ts';
import { extractPdfText } from './pdf.ts';
import { redactSecrets } from './redaction.ts';

// Parser dispatch: bytes -> bounded, secret-redacted text + structured output.
// Bump a parser's version whenever its output shape or semantics change; old
// extraction rows are kept, re-runs write new rows (reproducibility).

export const MAX_EXTRACTION_TEXT = 512 * 1024;

export interface ExtractionOutcome {
  parser_name: string;
  parser_version: number;
  status: 'ok' | 'failed';
  output_json: string | null;
  text: string | null;
  text_sha256: string | null;
  contains_secrets: boolean;
  error: string | null;
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.rst',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.html',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.ps1',
  '.sql',
  '.css',
  '.ini',
  '.cfg',
  '.gitignore',
  '.gitattributes',
]);

export function mimeFor(relpath: string): string {
  const ext = extname(relpath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.zip':
      return 'application/zip';
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.html':
      return 'text/html';
    default:
      return TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream';
  }
}

function finish(
  parser: string,
  version: number,
  rawText: string,
  structured: unknown,
): ExtractionOutcome {
  // Redact BEFORE truncating. Slicing first can cut a secret in half, which
  // both leaves the tail unmatched by patterns that need a trailing anchor and
  // stores the surviving prefix in cleartext.
  const { text: redactedFull, findings } = redactSecrets(rawText);
  const text =
    redactedFull.length > MAX_EXTRACTION_TEXT
      ? redactedFull.slice(0, MAX_EXTRACTION_TEXT)
      : redactedFull;

  // output_json goes through the scanner too. It holds parsed CSV cells and
  // header rows — exactly where an .env-style row or a token column lands — and
  // it was written to the database untouched while the text beside it was
  // scrubbed, so a secret survived in the structured column and
  // contains_secrets did not know about it.
  let outputJson: string | null = null;
  let structuredFindings: number = 0;
  if (structured !== null) {
    const scanned = redactSecrets(JSON.stringify(structured));
    outputJson =
      scanned.text.length > MAX_EXTRACTION_TEXT
        ? scanned.text.slice(0, MAX_EXTRACTION_TEXT)
        : scanned.text;
    structuredFindings = scanned.findings.length;
  }

  return {
    parser_name: parser,
    parser_version: version,
    status: 'ok',
    output_json: outputJson,
    text,
    text_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    contains_secrets: findings.length + structuredFindings > 0,
    error: null,
  };
}

function failed(parser: string, version: number, error: string): ExtractionOutcome {
  return {
    parser_name: parser,
    parser_version: version,
    status: 'failed',
    output_json: null,
    text: null,
    text_sha256: null,
    contains_secrets: false,
    error,
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  return text;
}

// casPath: where the immutable original lives (used by the out-of-process PDF
// parser, which reads the sealed copy — never the user's original file).
export async function extractFromBytes(
  relpath: string,
  bytes: Uint8Array,
  casPath: string,
): Promise<ExtractionOutcome> {
  const ext = extname(relpath).toLowerCase();

  if (ext === '.csv') {
    try {
      const rows = parseCsv(decodeUtf8(bytes));
      const text = rows.map((r) => r.join(' | ')).join('\n');
      return finish('csv', 1, text, { rows: rows.length, header: rows[0] ?? [] });
    } catch (err) {
      return failed('csv', 1, err instanceof Error ? err.message : String(err));
    }
  }

  if (ext === '.docx') {
    try {
      const { text, paragraphs } = await extractDocxText(Buffer.from(bytes));
      return finish('docx', 1, text, { paragraphs });
    } catch (err) {
      return failed('docx', 1, err instanceof Error ? err.message : String(err));
    }
  }

  if (ext === '.pdf') {
    try {
      const { pages } = await extractPdfText(casPath);
      return finish('pdf', 1, pages.join('\n\n'), { pages: pages.length });
    } catch (err) {
      return failed('pdf', 1, err instanceof Error ? err.message : String(err));
    }
  }

  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    return finish('text', 1, decodeUtf8(bytes), null);
  }

  return failed('none', 1, `no parser for extension '${ext}' (artifact stored without text)`);
}
