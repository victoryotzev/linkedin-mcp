import { describe, expect, it } from 'vitest';
import { parseCsv } from '@linkedin-mcp/importers';
import { DomainError } from '@linkedin-mcp/shared';

describe('csv parser', () => {
  // No fixture used to contain a stray quote, so an unquoted `"` opened quoted
  // mode and swallowed the following delimiters and newlines: an even number of
  // stray quotes merged rows silently, an odd number threw on the whole file.
  it('treats a quote inside an unquoted field as a literal character', () => {
    const rows = parseCsv('size,note\n24" monitor,fits the desk\nnext,row\n');
    expect(rows).toEqual([
      ['size', 'note'],
      ['24" monitor', 'fits the desk'],
      ['next', 'row'],
    ]);
  });

  it('parses quoted cells, escaped quotes, and embedded newlines', () => {
    const rows = parseCsv('a,"b ""quoted""","line1\nline2"\r\nc,d,e\n');
    expect(rows).toEqual([
      ['a', 'b "quoted"', 'line1\nline2'],
      ['c', 'd', 'e'],
    ]);
  });

  it('tolerates ragged rows (LinkedIn export preambles)', () => {
    const rows = parseCsv('Notes:\nFirst Name,Last Name\nAlex,Rivera\n');
    expect(rows).toEqual([['Notes:'], ['First Name', 'Last Name'], ['Alex', 'Rivera']]);
  });

  it('handles the observed Positions.csv header shape', () => {
    const rows = parseCsv('Company Name,Title,Description,Location,Started On,Finished On\n');
    expect(rows[0]).toHaveLength(6);
  });

  it('fails on unterminated quotes', () => {
    expect(() => parseCsv('a,"unterminated\nb,c')).toThrowError(DomainError);
  });

  it('enforces the cell cap', () => {
    expect(() => parseCsv('a,b\n'.repeat(10), { maxCells: 5, maxCellLength: 100 })).toThrowError(
      DomainError,
    );
  });
});
