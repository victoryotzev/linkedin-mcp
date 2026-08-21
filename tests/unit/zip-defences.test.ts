import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ZIP_LIMITS, readZipEntries } from '@linkedin-mcp/importers';
import { makeZip } from '../helpers/makeZip.ts';

// The archive reader's refusals.
//
// A LinkedIn export is a ZIP a member downloaded from a website, and this is
// the only code in the product that unpacks one. Every limit here exists
// because a ZIP can lie about itself: an entry can declare a size it does not
// have, claim a compression ratio no real document reaches, or be encrypted so
// nothing can read it at all.

/**
 * Builds a ZIP by hand so the header can say something the payload does not.
 *
 * makeZip writes honest archives; these tests need dishonest ones.
 */
function forgedZip(options: {
  name: string;
  payload: Buffer;
  declaredUncompressed?: number;
  compressed?: Buffer;
  encrypted?: boolean;
}): Buffer {
  const nameBytes = Buffer.from(options.name, 'utf8');
  const compressed = options.compressed ?? deflateRawSync(options.payload);
  const uncompressedSize = options.declaredUncompressed ?? options.payload.length;
  const crc = crc32(options.payload);
  const flags = options.encrypted ? 0x1 : 0x0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const localHeader = Buffer.concat([local, nameBytes, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralHeader = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.length, 12);
  end.writeUInt32LE(localHeader.length, 16);

  return Buffer.concat([localHeader, centralHeader, end]);
}

describe('an honest archive', () => {
  it('is read entry by entry, with its bytes intact', async () => {
    const zip = makeZip([
      { name: 'Profile.csv', data: Buffer.from('First Name\nAlex\n') },
      { name: 'Positions.csv', data: Buffer.from('Company Name\nVale Wind Power\n') },
    ]);

    const entries = await readZipEntries(zip);

    expect(entries.map((e) => e.relpath).sort()).toEqual(['Positions.csv', 'Profile.csv']);
    expect(entries.find((e) => e.relpath === 'Profile.csv')?.bytes.toString()).toContain('Alex');
  });

  it('skips directory entries rather than reading them as files', async () => {
    const zip = makeZip([
      { name: 'nested/', data: Buffer.alloc(0) },
      { name: 'nested/Profile.csv', data: Buffer.from('First Name\nAlex\n') },
    ]);

    const entries = await readZipEntries(zip);

    expect(entries.every((e) => !e.relpath.endsWith('/'))).toBe(true);
    expect(entries.length).toBe(1);
  });
});

describe('an archive that lies about itself', () => {
  it('refuses an entry declaring more bytes than the cap allows', async () => {
    const zip = forgedZip({
      name: 'huge.csv',
      payload: Buffer.from('small'),
      declaredUncompressed: DEFAULT_ZIP_LIMITS.maxEntryBytes + 1,
    });

    // The declared size is checked before a byte is decompressed, so a lie
    // costs nothing to catch.
    await expect(readZipEntries(zip)).rejects.toThrow(/per-entry size cap/i);
  });

  it('refuses an entry whose compression ratio no real document reaches', async () => {
    // A megabyte of zeroes compresses to almost nothing: the classic zip bomb
    // shape, and the reason the ratio is capped rather than only the size.
    const payload = Buffer.alloc(1024 * 1024, 0);
    const zip = forgedZip({ name: 'bomb.csv', payload });

    await expect(readZipEntries(zip)).rejects.toThrow(/compression-ratio cap|zip bomb/i);
  });

  it('enforces the cap while streaming, because a declared size can be a lie', async () => {
    // Declares one byte, delivers a megabyte. Only the streaming check catches
    // this, since the header said it was fine.
    const payload = Buffer.alloc(1024 * 1024, 0x41);
    const zip = forgedZip({
      name: 'liar.csv',
      payload,
      declaredUncompressed: 1,
    });

    // Caught either by the streaming accounting or by the decompressor itself
    // noticing more bytes than the header promised — both are refusals, and
    // which one fires depends on how far off the lie is.
    await expect(readZipEntries(zip)).rejects.toThrow(/ZIP/i);
  });

  it('refuses an encrypted entry rather than storing something it cannot read', async () => {
    const zip = forgedZip({
      name: 'locked.csv',
      payload: Buffer.from('secret'),
      encrypted: true,
    });

    await expect(readZipEntries(zip)).rejects.toThrow(/encrypted/i);
  });

  it('refuses an entry whose stream cannot be read', async () => {
    // Compressed bytes that are not valid deflate: the header parses, the
    // stream does not.
    const zip = forgedZip({
      name: 'corrupt.csv',
      payload: Buffer.from('original'),
      compressed: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]),
    });

    await expect(readZipEntries(zip)).rejects.toThrow(/ZIP entry/i);
  });

  it('refuses something that is not an archive at all', async () => {
    await expect(readZipEntries(Buffer.from('this is not a zip'))).rejects.toThrow();
  });
});

describe('the total across an archive', () => {
  it('is capped as well as each entry, so many small files cannot add up', async () => {
    // Each entry is comfortably under the per-entry cap; together they are not.
    // Only the streaming accounting can catch this: nothing in any one header
    // is out of bounds.
    const each = Buffer.alloc(4096, 0x42);
    const zip = makeZip(
      Array.from({ length: 8 }, (_, i) => ({ name: `file-${i}.csv`, data: each })),
    );

    await expect(
      readZipEntries(zip, {
        ...DEFAULT_ZIP_LIMITS,
        maxEntryBytes: 64 * 1024,
        maxTotalBytes: 10 * 1024,
      }),
    ).rejects.toThrow(/exceeded size caps/i);
  }, 60_000);

  it('reads the same archive whole when the total fits', async () => {
    const each = Buffer.alloc(4096, 0x42);
    const zip = makeZip(
      Array.from({ length: 8 }, (_, i) => ({ name: `file-${i}.csv`, data: each })),
    );

    const entries = await readZipEntries(zip, {
      ...DEFAULT_ZIP_LIMITS,
      maxEntryBytes: 64 * 1024,
      maxTotalBytes: 64 * 1024,
    });

    expect(entries).toHaveLength(8);
    expect(entries.every((e) => e.bytes.length === 4096)).toBe(true);
  }, 60_000);

  it('refuses an entry compressed by a method it cannot open', async () => {
    // Deflate64 and friends: the header parses and the entry looks ordinary,
    // and there is no reader for it. Skipping it silently would drop a document
    // out of an import that reported success.
    const zip = makeZip([
      { name: 'exotic.csv', data: Buffer.from('a,b\n1,2\n'), method: 9 as never },
    ]);

    await expect(readZipEntries(zip)).rejects.toThrow(/ZIP entry/i);
  });
});

describe('entry names', () => {
  it('refuses a name that tries to climb out of the archive', async () => {
    // Refused rather than sanitised, which is the stronger answer: a name that
    // tries to escape says something about the archive as a whole, not just
    // about that entry, and quietly rewriting it would hide that.
    await expect(
      readZipEntries(makeZip([{ name: '../../escape.csv', data: Buffer.from('nope') }])),
    ).rejects.toThrow(/invalid relative path/i);

    await expect(
      readZipEntries(makeZip([{ name: 'C:\\Windows\\hosts', data: Buffer.from('nope') }])),
    ).rejects.toThrow();
  });

  it('accepts an ordinary nested name', async () => {
    const entries = await readZipEntries(
      makeZip([{ name: 'nested/Profile.csv', data: Buffer.from('First Name\nAlex\n') }]),
    );

    expect(entries[0]?.relpath).toBe('nested/Profile.csv');
  });
});
