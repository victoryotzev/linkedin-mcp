// PDF text extraction, run as a CHILD PROCESS (not in the server): PDF parsers
// are the most crash/loop-prone code in the system, so the parent enforces a
// hard timeout + byte cap and treats any non-zero exit as a parse failure.
// Usage: node pdf-extract.mjs <absolute-pdf-path>
// Output: single JSON line on stdout: { pages: string[] } or { error: string }
import { readFileSync } from 'node:fs';

const path = process.argv[2];
try {
  const data = new Uint8Array(readFileSync(path));
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data,
    // No rendering, no external resources: text extraction only.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    // GHSA-hq66-cqwq-w95j: a malicious PDF gets arbitrary JavaScript execution
    // when enableScripting is left at its DEFAULT of true. isEvalSupported is a
    // different vector and does not cover it. Being a child process bounds
    // crashes and hangs, not code execution — this child runs as the member,
    // with the data directory and DPAPI Unprotect within reach.
    enableScripting: false,
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  process.stdout.write(JSON.stringify({ pages }));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(1);
}
