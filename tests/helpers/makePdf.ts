import { Buffer } from 'node:buffer';

// A minimal, genuinely valid PDF.
//
// The importer shells out to pdfjs in a child process, so covering it needs a
// file that a real parser accepts. Checking a binary fixture into the repo
// would mean nobody can read or review what the test is feeding the parser;
// building one here keeps the bytes in plain sight, and the cross-reference
// offsets have to be computed rather than guessed because that table is what a
// parser reads first.

/** Builds a single-page PDF whose text layer is exactly `lines`. */
export function makePdf(lines: readonly string[]): Buffer {
  const escaped = lines.map((line) => line.replace(/([\\()])/g, '\\$1'));
  const content =
    'BT /F1 18 Tf 72 720 Td 20 TL\n' +
    escaped.map((line) => `(${line}) Tj T*`).join('\n') +
    '\nET\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
