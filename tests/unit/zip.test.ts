import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { readZipEntries, sanitizeEntryName, DEFAULT_ZIP_LIMITS } from '@linkedin-mcp/importers';
import { DomainError } from '@linkedin-mcp/shared';
import { makeZip } from '../helpers/makeZip.ts';

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

// Entry names are fully attacker-controlled and flow into error messages,
// artifacts.source_relpath and MCP tool output. yauzl blocks path traversal but
// not control characters, newlines or length. Built with fromCharCode because
// these bytes cannot appear literally in source.
describe('zip entry-name sanitisation', () => {
  const NEWLINE = String.fromCharCode(10);
  const BELL = String.fromCharCode(7);
  const C1 = String.fromCharCode(0x9b);

  it('neutralises characters that could forge a log line or carry an escape sequence', () => {
    expect(sanitizeEntryName(`ok${NEWLINE}Injected: true`, 1)).not.toContain(NEWLINE);
    expect(sanitizeEntryName(`a${BELL}b`, 1)).not.toContain(BELL);
    expect(sanitizeEntryName(`x${C1}y`, 1)).not.toContain(C1);
  });

  it('leaves an ordinary archive path completely alone', () => {
    const real = 'Basic_LinkedInDataExport/Profile.csv';
    expect(sanitizeEntryName(real, 1)).toBe(real);
  });

  it('caps absurd lengths and names an empty entry by index', () => {
    expect(sanitizeEntryName('x'.repeat(5000), 3).length).toBeLessThanOrEqual(201);
    expect(sanitizeEntryName('   ', 7)).toBe('entry-7');
  });
});

describe('hardened zip reader', () => {
  it('reads a normal archive (store + deflate entries)', async () => {
    const zip = makeZip([
      { name: 'Profile.csv', data: Buffer.from('First Name,Last Name\nAlex,Rivera\n') },
      { name: 'Skills.csv', data: Buffer.from('Name\nTypeScript\n'), method: 8 },
    ]);
    const entries = await readZipEntries(zip);
    expect(entries.map((e) => e.relpath)).toEqual(['Profile.csv', 'Skills.csv']);
    expect(entries[1]!.bytes.toString()).toBe('Name\nTypeScript\n');
  });

  it('rejects zip-slip entry names outright (yauzl validation, defense in depth)', async () => {
    // Two layers protect here: our reader never uses entry names as
    // filesystem paths at all, AND yauzl refuses relative-traversal names
    // before we even see the entry.
    const dotdot = makeZip([{ name: '../../evil.txt', data: Buffer.from('escape attempt') }]);
    expect(await codeOf(() => readZipEntries(dotdot))).toBe('INVALID_INPUT');
    const backslash = makeZip([{ name: '..\\..\\evil2.txt', data: Buffer.from('escape 2') }]);
    expect(await codeOf(() => readZipEntries(backslash))).toBe('INVALID_INPUT');
  });

  it('rejects encrypted entries', async () => {
    const zip = makeZip([{ name: 'x.txt', data: Buffer.from('data'), flags: 0x1 }]);
    expect(await codeOf(() => readZipEntries(zip))).toBe('INVALID_INPUT');
  });

  it('rejects per-entry oversize', async () => {
    const zip = makeZip([{ name: 'big.bin', data: Buffer.alloc(2048, 7) }]);
    expect(
      await codeOf(() => readZipEntries(zip, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1024 })),
    ).toBe('INVALID_INPUT');
  });

  it('rejects compression-ratio bombs', async () => {
    // 4 MB of zeros deflates to ~4 KB: ratio ~1000, over the 100:1 cap.
    const zip = makeZip([{ name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024, 0), method: 8 }]);
    expect(await codeOf(() => readZipEntries(zip))).toBe('INVALID_INPUT');
  });

  it('rejects entry-count floods', async () => {
    const zip = makeZip(
      Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') })),
    );
    expect(await codeOf(() => readZipEntries(zip, { ...DEFAULT_ZIP_LIMITS, maxEntries: 10 }))).toBe(
      'INVALID_INPUT',
    );
  });

  it('rejects malformed bytes', async () => {
    expect(await codeOf(() => readZipEntries(Buffer.from('this is not a zip file')))).toBe(
      'INVALID_INPUT',
    );
  });
});
