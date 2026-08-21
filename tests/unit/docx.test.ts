import { describe, expect, it } from 'vitest';
import { extractDocxText } from '@linkedin-mcp/importers';
import { makeZip } from '../helpers/makeZip.ts';

// A .docx is a ZIP of XML, so this parser inherits the hardened reader's
// guards. What it adds is XML-to-text, and the interesting cases are the ones
// where markup and entities could leak into stored text or where a crafted
// archive could look like a Word file without being one.

function docx(documentXml: string, extra: Array<{ name: string; data: Buffer }> = []): Buffer {
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8'), method: 8 },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8'), method: 8 },
    ...extra.map((e) => ({ ...e, method: 8 as const })),
  ]);
}

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://x"><w:body>${body}</w:body></w:document>`;

const para = (...runs: string[]) =>
  `<w:p><w:r>${runs.map((t) => `<w:t>${t}</w:t>`).join('')}</w:r></w:p>`;

describe('extractDocxText', () => {
  it('extracts paragraph text and separates paragraphs by line', async () => {
    const { text, paragraphs } = await extractDocxText(
      docx(wrap(para('Alex Rivera') + para('Senior engineer at Vale Wind Power'))),
    );

    expect(text).toBe('Alex Rivera\nSenior engineer at Vale Wind Power');
    expect(paragraphs).toBe(2);
  });

  it('joins runs inside a paragraph without inventing whitespace', async () => {
    // Word splits a single sentence across runs whenever formatting changes;
    // gluing them with a space would corrupt words mid-token.
    const { text } = await extractDocxText(docx(wrap(para('Type', 'Script'))));

    expect(text).toBe('TypeScript');
  });

  it('turns explicit breaks and tabs into their characters', async () => {
    const { text } = await extractDocxText(
      docx(wrap('<w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t><w:tab/><w:t>c</w:t></w:r></w:p>')),
    );

    expect(text).toBe('a\nb\tc');
  });

  it('decodes XML entities, ampersand last so nothing double-decodes', async () => {
    const { text } = await extractDocxText(
      docx(wrap(para('R&amp;D at &lt;Vale&gt; &quot;Wind&quot;') + para('&amp;lt; stays literal'))),
    );

    expect(text).toBe('R&D at <Vale> "Wind"\n&lt; stays literal');
  });

  it('decodes numeric entities and drops ones that are not safe text', async () => {
    const { text } = await extractDocxText(docx(wrap(para('caf&#233; &#x2014; done&#0;&#xD800;'))));

    // A NUL and a lone surrogate would both end up in indexed, exported text.
    expect(text).toBe('café — done');
  });

  it('emits no markup even when text contains tag-like content', async () => {
    const { text } = await extractDocxText(docx(wrap(para('I maintain a parser'))));

    expect(text).not.toContain('<w:');
    expect(text).not.toContain('/>');
  });

  it('collapses the vertical whitespace Word emits', async () => {
    const { text } = await extractDocxText(
      docx(wrap(para('top') + '<w:p/><w:p/><w:p/>' + para('bottom'))),
    );

    expect(text).toBe('top\n\nbottom');
  });

  it('refuses an archive with no document body', async () => {
    const notWord = makeZip([{ name: 'readme.txt', data: Buffer.from('hello', 'utf8') }]);

    await expect(extractDocxText(notWord)).rejects.toThrow(/not a Word document/i);
  });

  it('refuses bytes that are not a ZIP at all', async () => {
    await expect(extractDocxText(Buffer.from('%PDF-1.7 not a zip', 'utf8'))).rejects.toThrow(
      /malformed ZIP/i,
    );
  });

  it('still applies the zip reader guards to a decompression bomb', async () => {
    // Highly compressible payload past the ratio guard the LinkedIn export
    // archive already relies on.
    const bomb = docx(wrap(para('x')), [
      { name: 'word/bomb.bin', data: Buffer.alloc(60 * 1024 * 1024, 0x41) },
    ]);

    await expect(extractDocxText(bomb)).rejects.toThrow();
  });
});
