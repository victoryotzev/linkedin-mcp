import { DomainError } from '@linkedin-mcp/shared';
import { readZipEntries, type ZipLimits } from './zip.ts';

// A .docx is a ZIP holding XML, so this reuses the hardened reader rather than
// adding a parser dependency: the entry-count, per-entry, total-size and
// compression-ratio guards that protect the LinkedIn export archive apply here
// unchanged, and there is no new attack surface beyond XML this module reads
// without an XML parser.
//
// Most people's CV is a Word file, and until now the importer had no branch for
// one at all — it stored the bytes and reported "no parser for extension".
//
// What this extracts is the document body as plain text. Not headers, footers,
// footnotes, comments, tracked changes, text boxes or embedded objects. That is
// a deliberate floor rather than an oversight: the body is where a CV's claims
// live, and every additional part is another place for content the member did
// not think they were importing to arrive silently.

// A single .docx part large enough to matter is already pathological; the ZIP
// reader's own ceilings still apply on top of this.
const DOCX_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
};

const BODY_PART = 'word/document.xml';

/** `<w:br/>`, `<w:cr/>` and paragraph ends all read as line breaks. */
const BREAK = /<w:(?:br|cr)\s*\/?>/g;
// Both spellings of a paragraph ending. An empty paragraph is a blank line the
// member deliberately left in, and Word writes it either as `<w:p></w:p>` or,
// when it carries no properties at all, as a self-closing `<w:p/>`.
const PARAGRAPH_END = /<\/w:p>|<w:p\s*\/>/g;
/** Tab characters are their own element rather than whitespace in the text run. */
const TAB = /<w:tab\s*\/?>/g;
/** Everything else is markup; the text lives in the leaves between tags. */
const ANY_TAG = /<[^>]*>/g;

const ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  // Ampersand last, or a literal `&amp;lt;` in the source would decode twice.
  [/&amp;/g, '&'],
];

function decodeEntities(text: string): string {
  let out = text.replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
    safeCodePoint(Number.parseInt(hex, 16)),
  );
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out;
}

function safeCodePoint(code: number): string {
  // A numeric entity is attacker-controlled. Out-of-range values throw from
  // fromCodePoint, and surrogates would produce lone halves in stored text.
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  return String.fromCodePoint(code);
}

export interface DocxExtractResult {
  text: string;
  paragraphs: number;
}

export async function extractDocxText(bytes: Buffer): Promise<DocxExtractResult> {
  const entries = await readZipEntries(bytes, DOCX_LIMITS);
  const body = entries.find((entry) => entry.relpath === BODY_PART);
  if (!body) {
    throw new DomainError(
      'INVALID_INPUT',
      `not a Word document: no ${BODY_PART} inside the archive`,
      { blockers: ['docx_missing_body'] },
    );
  }

  const xml = body.bytes.toString('utf8');
  const withBreaks = xml.replace(BREAK, '\n').replace(TAB, '\t').replace(PARAGRAPH_END, '\n');

  const text = decodeEntities(withBreaks.replace(ANY_TAG, ''))
    // Word emits a great deal of vertical whitespace; collapse runs of blank
    // lines so the extraction ceiling is not spent on empty paragraphs.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const paragraphs = (xml.match(PARAGRAPH_END) ?? []).length;
  return { text, paragraphs };
}
