import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFromBytes, extractPdfText, mimeFor } from '@linkedin-mcp/importers';
import { makePdf } from '../helpers/makePdf.ts';
import { makeZip } from '../helpers/makeZip.ts';

// PDF extraction and the extension dispatch in front of it.
//
// The PDF reader runs pdfjs in a child process, deliberately: a malformed file
// takes the child down and not the server. Nothing had exercised it, so neither
// the success path nor the three ways it can fail had ever run.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-pdf-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function write(name: string, bytes: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('reading a PDF', () => {
  it('returns the text of each page', async () => {
    const path = write(
      'cv.pdf',
      makePdf(['Alex Rivera', 'Built a deterministic CSV parser', 'and a backup verifier.']),
    );

    const { pages } = await extractPdfText(path);

    expect(pages.length).toBe(1);
    expect(pages[0]).toContain('Alex Rivera');
    expect(pages[0]).toContain('deterministic CSV parser');
  });

  it('reports a file that is not a PDF at all, rather than hanging or crashing', async () => {
    const path = write('not-really.pdf', Buffer.from('this is plain text, not a PDF'));

    await expect(extractPdfText(path)).rejects.toThrow(/PDF extraction failed/i);
  });

  it('reports a file that does not exist', async () => {
    await expect(extractPdfText(join(dir, 'missing.pdf'))).rejects.toThrow(
      /PDF extraction failed/i,
    );
  });

  it('reports a PDF whose structure is broken', async () => {
    // A valid header and nothing behind it: the parser gets far enough to try
    // and then has nothing to read.
    const path = write('truncated.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'));

    await expect(extractPdfText(path)).rejects.toThrow(/PDF extraction failed/i);
  });
});

describe('the extension dispatch', () => {
  it('names the media type for each kind this product reads', () => {
    expect(mimeFor('cv.pdf')).toBe('application/pdf');
    expect(mimeFor('notes.docx')).toContain('wordprocessingml');
    expect(mimeFor('export.zip')).toBe('application/zip');
    expect(mimeFor('Profile.csv')).toBe('text/csv');
    expect(mimeFor('package.json')).toBe('application/json');
    expect(mimeFor('README.md')).toBe('text/markdown');
    expect(mimeFor('page.html')).toBe('text/html');
  });

  it('treats known source and config extensions as text', () => {
    for (const name of ['index.ts', 'main.py', 'app.ini', 'settings.cfg', 'root.gitignore']) {
      expect(mimeFor(name), name).toBe('text/plain');
    }
  });

  it('treats a dotfile as having no extension, because that is what it has', () => {
    // extname('.gitignore') is '', not '.gitignore'. The dispatch has to agree
    // with the filesystem rather than with what the name looks like.
    expect(mimeFor('.gitignore')).toBe('application/octet-stream');
  });

  it('falls back to a binary type for anything it does not read', () => {
    expect(mimeFor('photo.jpeg')).toBe('application/octet-stream');
    expect(mimeFor('archive.tar.gz')).toBe('application/octet-stream');
  });

  it('is case-insensitive, because Windows filenames are', () => {
    expect(mimeFor('CV.PDF')).toBe('application/pdf');
    expect(mimeFor('Profile.CSV')).toBe('text/csv');
  });
});

describe('extracting from bytes', () => {
  const extract = (name: string, bytes: Buffer) =>
    extractFromBytes(name, new Uint8Array(bytes), write(name, bytes));

  it('reads a CSV into rows and keeps the header', async () => {
    const outcome = await extract('Profile.csv', Buffer.from('First,Last\nAlex,Rivera\n'));

    expect(outcome.status).toBe('ok');
    expect(outcome.text).toContain('Alex | Rivera');
    expect(outcome.output_json).toContain('header');
  });

  it('reads a DOCX into paragraphs', async () => {
    const document =
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
      '<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const bytes = makeZip([{ name: 'word/document.xml', data: Buffer.from(document) }]);

    const outcome = await extract('notes.docx', bytes);

    expect(outcome.status).toBe('ok');
    expect(outcome.text).toContain('First paragraph.');
    expect(outcome.text).toContain('Second paragraph.');
  });

  it('records a failure rather than throwing when a reader cannot cope', async () => {
    const outcome = await extract('broken.docx', Buffer.from('not a zip at all'));

    // A single unreadable file must not stop an import; it is recorded as
    // failed so the member can see which one and why.
    expect(outcome.status).toBe('failed');
    expect(outcome.text ?? '').toBe('');
  });

  it('reads a PDF through the child process', async () => {
    const bytes = makePdf(['Portfolio', 'Shipped an evidence-backed publishing tool.']);
    const outcome = await extract('cv.pdf', bytes);

    expect(outcome.status).toBe('ok');
    expect(outcome.text).toContain('Portfolio');
  });

  it('records a PDF failure without taking the import down', async () => {
    const outcome = await extract('bad.pdf', Buffer.from('definitely not a pdf'));
    expect(outcome.status).toBe('failed');
  });

  it('reads an extensionless file as text', async () => {
    const outcome = await extract('Makefile', Buffer.from('build:\n\ttsc -b\n'));

    expect(outcome.status).toBe('ok');
    expect(outcome.text).toContain('tsc -b');
  });

  it('redacts a credential before storing anything, in the text and the structured output', async () => {
    const outcome = await extract(
      'secrets.csv',
      Buffer.from('name,value\ntoken,AQV-fake-fixture-token-0123456789abcdefghij\n'),
    );

    // Redaction runs before truncation and covers output_json as well as the
    // text: parsed CSV cells are exactly where a token column lands.
    expect(outcome.text ?? '').not.toContain('AQV-fake-fixture-token-0123456789');
    expect(outcome.output_json ?? '').not.toContain('AQV-fake-fixture-token-0123456789');
    expect(outcome.contains_secrets).toBe(true);
  });

  it('does not offer to read a type it has no reader for', async () => {
    const outcome = await extract('photo.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(['skipped', 'failed', 'ok']).toContain(outcome.status);
    expect(outcome.parser_name).not.toBe('pdf');
  });
});
