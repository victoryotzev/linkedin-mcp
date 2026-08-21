import { DomainError } from '@linkedin-mcp/shared';

// Strict-but-tolerant RFC 4180 parser sized for LinkedIn export CSVs: quoted
// fields with "" escapes, embedded newlines, CRLF/LF, ragged rows allowed
// (LinkedIn ships them — e.g. Connections.csv has a "Notes:" preamble row).
// Hard caps keep a malicious file from ballooning memory.

export interface CsvLimits {
  maxCells: number;
  maxCellLength: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxCells: 500_000,
  maxCellLength: 100_000,
};

export function parseCsv(rawInput: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): string[][] {
  // BOM stripped here rather than in one caller: the extraction path decoded it
  // away while parseCsv's other consumers did not, so the same file parsed two
  // different ways depending on which door it came through, and the first
  // header cell silently carried a leading U+FEFF that column lookups missed.
  const input = rawInput.charCodeAt(0) === 0xfeff ? rawInput.slice(1) : rawInput;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cells = 0;

  const pushCell = () => {
    if (cell.length > limits.maxCellLength) {
      throw new DomainError('INVALID_INPUT', 'CSV cell exceeds length cap');
    }
    row.push(cell);
    cell = '';
    if (++cells > limits.maxCells) {
      throw new DomainError('INVALID_INPUT', 'CSV exceeds total cell cap');
    }
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    switch (ch) {
      case '"':
        // A quote only OPENS a quoted cell at the start of that cell. Treating
        // any `"` as an opener meant a single literal quote inside an unquoted
        // field (5"2, 24" monitor, he said "hi") swallowed every following
        // comma and newline: an even number of stray quotes merged rows
        // silently, an odd number threw on the whole file. This matches
        // Python's csv module and papaparse.
        if (cell.length === 0) {
          inQuotes = true;
        } else {
          cell += ch;
        }
        break;
      case ',':
        pushCell();
        break;
      case '\r':
        if (input[i + 1] === '\n') i++;
        pushRow();
        break;
      case '\n':
        pushRow();
        break;
      default:
        cell += ch;
    }
  }
  if (inQuotes) {
    throw new DomainError('INVALID_INPUT', 'CSV ends inside an unterminated quoted cell');
  }
  if (cell.length > 0 || row.length > 0) pushRow();

  // Drop a trailing fully-empty row produced by a final newline.
  const last = rows.at(-1);
  if (last && last.length === 1 && last[0] === '') rows.pop();
  return rows;
}
