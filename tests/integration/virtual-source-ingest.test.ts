import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enableSourceFromDashboard,
  getSource,
  ingestBytes,
  isVirtualSource,
  listArtifacts,
  registerVirtualSource,
} from '@linkedin-mcp/domain';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';
import { makeZip } from '../helpers/makeZip.ts';

// Uploads and typed self-description reach the artifact store without a
// directory scan. The point of these tests is that "without a directory scan"
// does not become "without the protections the scan path applies" — ingestBytes
// hands a synthetic candidate to the same importOne, and these assertions are
// what would fail if someone replaced that with a second implementation.

let fx: Fixture;

beforeEach(() => {
  fx = createFixture('virtual');
});

afterEach(() => {
  fx.close();
});

function enabledSource(trust: 'self_attested' | 'personal_doc' = 'self_attested') {
  const source = registerVirtualSource(fx.db, {
    origin: trust === 'self_attested' ? 'self_description' : 'upload',
    label: 'About me',
    trust,
  });
  return enableSourceFromDashboard(fx.db, source.id, 'human_cli');
}

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('virtual sources', () => {
  it('registers with no filesystem path and lands in pending_review', () => {
    const source = registerVirtualSource(fx.db, {
      origin: 'self_description',
      label: 'About me',
      trust: 'self_attested',
    });

    // Registration is not trust. The ENABLE confirmation is unchanged.
    expect(source.status).toBe('pending_review');
    expect(source.kind).toBe('manual');
    expect(source.root_path).toBe(`manual://${source.id}`);
    expect(isVirtualSource(source)).toBe(true);
  });

  it('keys the sentinel on the source id so two uploads never collide', () => {
    const a = registerVirtualSource(fx.db, {
      origin: 'upload',
      label: 'CV',
      trust: 'personal_doc',
    });
    const b = registerVirtualSource(fx.db, {
      origin: 'upload',
      label: 'CV',
      trust: 'personal_doc',
    });

    expect(a.root_path).not.toBe(b.root_path);
    expect(a.root_path.startsWith('upload://')).toBe(true);
  });

  it('round-trips the self_attested trust class through storage', () => {
    const source = registerVirtualSource(fx.db, {
      origin: 'self_description',
      label: 'About me',
      trust: 'self_attested',
    });

    expect(getSource(fx.db, source.id).trust).toBe('self_attested');
    // Stored as personal_doc plus a flag; the split must not leak upward.
    const row = fx.db.get('SELECT trust, self_attested FROM sources WHERE id = ?', source.id);
    expect(row?.['trust']).toBe('personal_doc');
    expect(row?.['self_attested']).toBe(1);
  });

  it('leaves an ordinary source unmarked', () => {
    const source = registerVirtualSource(fx.db, {
      origin: 'upload',
      label: 'CV',
      trust: 'personal_doc',
    });

    expect(getSource(fx.db, source.id).trust).toBe('personal_doc');
    expect(
      fx.db.get('SELECT self_attested FROM sources WHERE id = ?', source.id)?.['self_attested'],
    ).toBe(0);
  });
});

describe('ingestBytes', () => {
  it('refuses a source that has not been enabled', async () => {
    const source = registerVirtualSource(fx.db, {
      origin: 'upload',
      label: 'CV',
      trust: 'personal_doc',
    });

    await expect(
      ingestBytes(fx.db, fx.store, { source_id: source.id, filename: 'cv.md', bytes: bytes('hi') }),
    ).rejects.toThrow(/enable/i);
  });

  it('imports one artifact and reports it', async () => {
    const source = enabledSource();

    const report = await ingestBytes(fx.db, fx.store, {
      source_id: source.id,
      filename: 'about-me.md',
      bytes: bytes('I maintain a local-first evidence tool.'),
    });

    expect(report.files_seen).toBe(1);
    expect(report.files_imported).toBe(1);
    expect(report.files_rejected).toBe(0);
    expect(report.new_artifact_ids).toHaveLength(1);

    const artifacts = listArtifacts(fx.db, { source_id: source.id }, fx.fts5);
    expect(artifacts.map((a) => a.source_relpath)).toEqual(['about-me.md']);
  });

  it('still redacts secrets, because it is the same extraction path', async () => {
    const source = enabledSource();

    await ingestBytes(fx.db, fx.store, {
      source_id: source.id,
      filename: 'about-me.md',
      bytes: bytes('I run infra. My key is AKIAIOSFODNN7EXAMPLE and it should never be stored.'),
    });

    const text = String(
      fx.db.get(
        `SELECT e.text FROM extractions e
         JOIN artifacts a ON a.id = e.artifact_id
         WHERE a.source_id = ?`,
        source.id,
      )?.['text'] ?? '',
    );

    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('[REDACTED:aws_access_key:');
    // The surrounding prose survives; over-redaction would be its own bug.
    expect(text).toContain('I run infra.');
  });

  it('detects a duplicate rather than storing the bytes twice', async () => {
    const source = enabledSource();
    const payload = bytes('Exactly the same words.');

    const first = await ingestBytes(fx.db, fx.store, {
      source_id: source.id,
      filename: 'about-me.md',
      bytes: payload,
    });
    const second = await ingestBytes(fx.db, fx.store, {
      source_id: source.id,
      filename: 'about-me.md',
      bytes: payload,
    });

    expect(first.files_imported).toBe(1);
    expect(second.files_imported).toBe(0);
    expect(second.files_skipped_dup).toBe(1);
  });

  it('enforces the import size ceiling before storing anything', async () => {
    const source = enabledSource();
    // The default ceiling is 50 MB; one byte over is enough to prove the check.
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);

    await expect(
      ingestBytes(fx.db, fx.store, {
        source_id: source.id,
        filename: 'huge.md',
        bytes: oversized,
      }),
    ).rejects.toThrow(/ceiling/i);

    expect(listArtifacts(fx.db, { source_id: source.id }, fx.fts5)).toHaveLength(0);
  });

  it('refuses an empty file', async () => {
    const source = enabledSource();

    await expect(
      ingestBytes(fx.db, fx.store, {
        source_id: source.id,
        filename: 'about-me.md',
        bytes: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/empty/i);
  });

  it('extracts a .docx end to end, redaction included', async () => {
    // Proves the parser is actually wired into the extraction dispatch, not
    // merely present: a Word CV is the common case that had no branch at all.
    const source = enabledSource('personal_doc');
    const documentXml =
      '<w:document xmlns:w="http://x"><w:body>' +
      '<w:p><w:r><w:t>Alex Rivera</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>token AKIAIOSFODNN7EXAMPLE here</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const docxBytes = makeZip([
      { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8'), method: 8 },
    ]);

    const report = await ingestBytes(fx.db, fx.store, {
      source_id: source.id,
      filename: 'cv.docx',
      bytes: docxBytes,
    });
    expect(report.files_imported).toBe(1);

    const row = fx.db.get(
      `SELECT e.text, e.parser_name, e.status FROM extractions e
       JOIN artifacts a ON a.id = e.artifact_id
       WHERE a.source_id = ?`,
      source.id,
    );
    expect(row?.['status']).toBe('ok');
    expect(row?.['parser_name']).toBe('docx');
    expect(String(row?.['text'])).toContain('Alex Rivera');
    expect(String(row?.['text'])).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('refuses a filename carrying a path separator', async () => {
    const source = enabledSource();

    for (const filename of ['..\\escape.md', 'nested/dir.md']) {
      await expect(
        ingestBytes(fx.db, fx.store, { source_id: source.id, filename, bytes: bytes('x') }),
      ).rejects.toThrow(/path separator/i);
    }
  });
});
