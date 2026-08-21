import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@linkedin-mcp/shared';

// The importer's edges: a parser that will not answer, a file that will not
// read, and input shaped to break the reader rather than to be read.
//
// Everything here happens on a member's own machine with files they chose, so
// none of it is exotic: a PDF the bundled parser cannot open, a directory an
// endpoint agent has locked, a CSV with a megabyte in one cell. The rule is the
// same throughout — refuse or skip with a reason, never hang and never store a
// half-read file as though it were whole.

const VANISH_DIR = 'VANISH-READDIR';
const VANISH_STAT = 'VANISH-STAT';

let pdfAnswer: { stdout: string; error?: NodeJS.ErrnoException & { stdout?: string } } = {
  stdout: JSON.stringify({ pages: ['page one'] }),
};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      callback?: (err: unknown, out: { stdout: string; stderr: string }) => void,
    ) => {
      // The real child spawns node and loads pdfjs; what is under test is how
      // its answer is read, so the child is stood in for.
      queueMicrotask(() => {
        if (pdfAnswer.error) callback?.(pdfAnswer.error, { stdout: '', stderr: '' });
        else callback?.(null, { stdout: pdfAnswer.stdout, stderr: '' });
      });
      return {};
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
  return {
    ...actual,
    readdirSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(VANISH_DIR)) throw enoent(String(path));
      return (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    statSync: (path: unknown, ...rest: unknown[]) => {
      if (String(path).includes(VANISH_STAT)) throw enoent(String(path));
      return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { extractPdfText } = await import('../../packages/importers/src/pdf.ts');
const { parseCsv } = await import('../../packages/importers/src/csv.ts');
const { isReparsePoint } = await import('../../packages/importers/src/pathGuard.ts');
const { scanRepo } = await import('../../packages/importers/src/repoScan.ts');
const { extractFromBytes, MAX_EXTRACTION_TEXT } = await import(
  '../../packages/importers/src/extract.ts'
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-imp-'));
  pdfAnswer = { stdout: JSON.stringify({ pages: ['page one'] }) };
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

const write = (relpath: string, text: string): void => {
  const full = join(root, relpath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text, 'utf8');
};

describe('reading a PDF through the child parser', () => {
  it('returns the pages when the child answers', async () => {
    expect(await extractPdfText(join(root, 'cv.pdf'))).toEqual({ pages: ['page one'] });
  });

  it('says the parser was killed when it runs out of time', async () => {
    pdfAnswer = {
      stdout: '',
      error: Object.assign(new Error('killed'), { killed: true, stdout: '' }),
    };

    // A hostile or merely enormous PDF must not hold an import open forever.
    await expect(extractPdfText(join(root, 'cv.pdf'))).rejects.toThrow(/timed out/i);
  });

  it('surfaces the reason the child reported when it exited badly', async () => {
    pdfAnswer = {
      stdout: '',
      error: Object.assign(new Error('exit 1'), {
        stdout: JSON.stringify({ error: 'encrypted document' }),
      }),
    };

    // The child writes a JSON error line even on a non-zero exit; passing it
    // through is the difference between "PDF extraction failed" and "this one
    // is password-protected".
    await expect(extractPdfText(join(root, 'cv.pdf'))).rejects.toThrow(/encrypted document/i);
  });

  it('says so plainly when the child produced nothing readable', async () => {
    pdfAnswer = {
      stdout: '',
      error: Object.assign(new Error('exit 1'), { stdout: 'Segmentation' }),
    };

    await expect(extractPdfText(join(root, 'cv.pdf'))).rejects.toThrow(/unparseable output/i);
  });

  it('says so when the child exits cleanly with no pages', async () => {
    pdfAnswer = { stdout: JSON.stringify({ error: 'no text layer' }) };

    // Exit zero is not enough: a PDF of scanned images parses fine and contains
    // no text, and reporting an empty extraction as a success would file it as
    // evidence of nothing.
    await expect(extractPdfText(join(root, 'cv.pdf'))).rejects.toThrow(/no text layer/i);
  });
});

describe('parsing a CSV', () => {
  it('refuses a cell longer than any real field', () => {
    // A single enormous cell is how a CSV becomes a memory exhaustion, and no
    // LinkedIn export field is anywhere near this.
    expect(() => parseCsv(`name,note\nAlex,"${'x'.repeat(100_001)}"\n`)).toThrow(
      /cell exceeds length cap/i,
    );
  });

  it('refuses more cells than a real export has', () => {
    expect(() => parseCsv('a,'.repeat(600_000))).toThrow(/cell cap/i);
  });
});

describe('extracting from bytes', () => {
  it('records a CSV it could not parse as a failed extraction, not a crash', async () => {
    const outcome = await extractFromBytes(
      'Shares.csv',
      new TextEncoder().encode(`name\n"${'x'.repeat(100_001)}"\n`),
      join(root, 'unused'),
    );

    // One bad file must not abandon an import, and the reason is what tells the
    // member whether it mattered.
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/cell exceeds length cap/i);
  });

  it('truncates text past the ceiling rather than storing the whole file', async () => {
    const outcome = await extractFromBytes(
      'notes.md',
      new TextEncoder().encode('a'.repeat(MAX_EXTRACTION_TEXT + 5_000)),
      join(root, 'unused'),
    );

    // The extraction column is for search and preview, not for holding a copy
    // of the file — the bytes themselves are already in the store.
    expect(outcome.text?.length).toBe(MAX_EXTRACTION_TEXT);
  });

  it('truncates the structured column on the same ceiling', async () => {
    const wide = Array.from(
      { length: 20_000 },
      (_, i) => `column_number_${i}_with_a_long_name`,
    ).join(',');
    const outcome = await extractFromBytes(
      'Wide.csv',
      new TextEncoder().encode(`${wide}\n${wide}\n`),
      join(root, 'unused'),
    );

    // The structured column holds parsed cells and header rows, which is
    // exactly where a token column lands — so it is scanned and capped like the
    // text beside it rather than stored whole.
    expect(outcome.status).toBe('ok');
    expect(outcome.output_json?.length).toBe(MAX_EXTRACTION_TEXT);
  });
});

describe('deciding whether a path is safe to walk', () => {
  it('treats a path it cannot read as unsafe', () => {
    // Unreadable is not the same as absent, and the scan has no way to tell.
    // Assuming "not a link" would be the one assumption that lets a junction
    // walk out of the source root.
    expect(isReparsePoint(join(root, 'does-not-exist'))).toBe(true);
  });

  it('treats an ordinary file as safe', () => {
    write('README.md', '# notes');
    expect(isReparsePoint(join(root, 'README.md'))).toBe(false);
  });
});

describe('scanning a repository', () => {
  it('walks past a directory it cannot list', () => {
    write('README.md', '# notes');
    mkdirSync(join(root, VANISH_DIR), { recursive: true });

    const scan = scanRepo(root, 5 * 1024 * 1024);

    // A locked or unmounted subdirectory costs that subdirectory, not the scan.
    expect(scan.evidenceFiles.some((f) => /README/i.test(f))).toBe(true);
  });

  it('walks past an entry it cannot stat', () => {
    write('README.md', '# notes');
    write(`${VANISH_STAT}.md`, 'gone between the listing and the stat');

    const scan = scanRepo(root, 5 * 1024 * 1024);

    expect(scan.evidenceFiles.some((f) => f.includes(VANISH_STAT))).toBe(false);
    expect(scan.evidenceFiles.some((f) => /README/i.test(f))).toBe(true);
  });
});

describe('canonical JSON', () => {
  it('drops an undefined property, the way JSON.stringify does', () => {
    // An absent key and a key set to undefined are the same object as far as
    // JSON is concerned, so they must hash the same.
    expect(canonicalJson({ a: 1, b: undefined } as never)).toBe(canonicalJson({ a: 1 }));
  });

  it('refuses an undefined that cannot be dropped', () => {
    // Inside an array there is no key to omit, and encoding it as null would
    // make [undefined] and [null] hash identically. Every hash in the product
    // is taken over canonical JSON, and the audit chain is built on distinct
    // values staying distinct.
    expect(() => canonicalJson([undefined] as never)).toThrow(/not representable/i);
  });

  it('refuses a type JSON has no place for', () => {
    expect(() => canonicalJson((() => 1) as never)).toThrow(/unsupported type/i);
    expect(() => canonicalJson(Symbol('x') as never)).toThrow(/unsupported type/i);
  });
});
