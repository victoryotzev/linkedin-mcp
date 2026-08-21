import { Buffer } from 'node:buffer';
import yauzl from 'yauzl';
import { DomainError } from '@linkedin-mcp/shared';

// Hardened ZIP reader for the LinkedIn export archive (and any future ZIP
// source). Entry names are NEVER used as filesystem paths — bytes stream into
// the content-addressed store under server-generated hash names, so zip-slip
// is impossible by construction. The name survives only as metadata
// (source_relpath). Ceilings ported from Seller's verify_backup.py.

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 100,
};

export interface ZipEntryData {
  relpath: string;
  bytes: Buffer;
}

// yauzl rejects backslashes, absolute paths and `..` segments, but not control
// characters, embedded newlines or absurd length — and this name is fully
// attacker-controlled text that flows into DomainError messages, into
// artifacts.source_relpath, and out through MCP tool results. A newline plus a
// spoofed prefix is a cheap way to forge a log line or to feed instructions to
// a model reading the output.
const MAX_ENTRY_NAME = 200;
// C0 and C1 control ranges, written as escapes so the source stays printable.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the purpose
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;

export function sanitizeEntryName(raw: string, index: number): string {
  const cleaned = raw.replace(CONTROL_CHARS, '�').trim();
  if (cleaned.length === 0) return `entry-${index}`;
  return cleaned.length > MAX_ENTRY_NAME ? `${cleaned.slice(0, MAX_ENTRY_NAME)}…` : cleaned;
}

export async function readZipEntries(
  zipBytes: Buffer,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<ZipEntryData[]> {
  return await new Promise((resolve, reject) => {
    const out: ZipEntryData[] = [];
    let totalBytes = 0;
    let entryCount = 0;

    yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new DomainError('INVALID_INPUT', `malformed ZIP: ${err?.message ?? 'unreadable'}`));
        return;
      }
      const fail = (e: Error) => {
        zipfile.close();
        reject(e);
      };
      zipfile.on('error', (e: Error) =>
        fail(new DomainError('INVALID_INPUT', `malformed ZIP: ${e.message}`)),
      );
      zipfile.on('end', () => resolve(out));
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (++entryCount > limits.maxEntries) {
          fail(new DomainError('INVALID_INPUT', 'ZIP exceeds entry-count cap'));
          return;
        }
        // Sanitised once, here, so nothing downstream has to remember to.
        const name = sanitizeEntryName(entry.fileName, entryCount);
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry(); // directory
          return;
        }
        // eslint-disable-next-line no-bitwise
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          fail(new DomainError('INVALID_INPUT', `encrypted ZIP entry refused: ${name}`));
          return;
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          fail(new DomainError('INVALID_INPUT', `ZIP entry exceeds per-entry size cap: ${name}`));
          return;
        }
        if (
          entry.compressedSize > 0 &&
          entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
        ) {
          fail(
            new DomainError(
              'INVALID_INPUT',
              `ZIP entry exceeds compression-ratio cap (possible zip bomb): ${name}`,
            ),
          );
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(new DomainError('INVALID_INPUT', `unreadable ZIP entry: ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          let entryBytes = 0;
          stream.on('data', (chunk: Buffer) => {
            entryBytes += chunk.length;
            totalBytes += chunk.length;
            // Declared sizes can lie; enforce while streaming too.
            if (entryBytes > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
              stream.destroy();
              fail(new DomainError('INVALID_INPUT', `ZIP stream exceeded size caps: ${name}`));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (e: Error) =>
            fail(new DomainError('INVALID_INPUT', `ZIP entry stream error: ${e.message}`)),
          );
          stream.on('end', () => {
            out.push({ relpath: name, bytes: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}
