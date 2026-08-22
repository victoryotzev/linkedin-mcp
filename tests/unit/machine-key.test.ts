import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveKeyEncryptionKey,
  readMachineId,
  unwrapWithMachineKey,
  wrapWithMachineKey,
} from '@linkedin-mcp/domain';
import { DomainError } from '@linkedin-mcp/shared';

// The Linux stand-in for DPAPI.
//
// None of this reads the real machine id: the identity is an argument, which is
// what lets the Linux vault be tested from a Windows runner and the reverse.
// The properties being checked are the ones the vault's guarantee rests on —
// the key is reproducible on the same host, different on any other, and the
// wrapped blob refuses to open under the wrong one.

const MACHINE_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const MACHINE_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-machine-id-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function machineIdFile(contents: string, name = 'machine-id'): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('reading the host machine id', () => {
  it('reads the first path that exists, so the D-Bus fallback still works', () => {
    const missing = join(dir, 'etc-machine-id');
    const fallback = machineIdFile(`${MACHINE_A}\n`, 'dbus-machine-id');

    expect(readMachineId([missing, fallback])).toBe(MACHINE_A);
  });

  it('trims the trailing newline the file is written with', () => {
    expect(readMachineId([machineIdFile(`${MACHINE_A}\n`)])).toBe(MACHINE_A);
  });

  it('says so when there is no machine id at all, rather than inventing one', () => {
    // A host without systemd or D-Bus is a real configuration. The vault is
    // unavailable there, and the message says the rest of the product is not.
    try {
      readMachineId([join(dir, 'nope'), join(dir, 'also-nope')]);
      expect.unreachable('a missing machine id must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).blockers).toContain('machine_id_unavailable');
      expect((error as DomainError).message).toMatch(/works without stored credentials/i);
    }
  });

  it('refuses an empty machine id', () => {
    try {
      readMachineId([machineIdFile('   \n')]);
      expect.unreachable('an empty machine id must throw');
    } catch (error) {
      expect((error as DomainError).blockers).toContain('machine_id_empty');
    }
  });

  it('refuses something that is not a machine id', () => {
    // Deriving a vault key from an unvalidated file would put the whole
    // guarantee on a value nobody checked.
    for (const bogus of [
      'hello world',
      MACHINE_A.slice(0, 31),
      `${MACHINE_A}ff`,
      MACHINE_A.toUpperCase(),
    ]) {
      try {
        readMachineId([machineIdFile(bogus, `id-${bogus.length}-${bogus.slice(0, 4)}`)]);
        expect.unreachable(`must reject ${bogus}`);
      } catch (error) {
        expect((error as DomainError).blockers).toContain('machine_id_malformed');
      }
    }
  });
});

describe('deriving the key-encryption key', () => {
  it('is reproducible, so the next process opens what this one sealed', () => {
    const first = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1000 });
    const second = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1000 });

    expect(first.equals(second)).toBe(true);
    expect(first).toHaveLength(32);
  });

  it('differs by machine, which is what makes a copied data home useless', () => {
    const here = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1000 });
    const elsewhere = deriveKeyEncryptionKey({ machineId: MACHINE_B, uid: 1000 });

    expect(here.equals(elsewhere)).toBe(false);
  });

  it('differs by user, the way DPAPI CurrentUser does', () => {
    const mine = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1000 });
    const theirs = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1001 });

    expect(mine.equals(theirs)).toBe(false);
  });

  it('refuses a user id that is not a real one', () => {
    for (const uid of [-1, 1.5, Number.NaN]) {
      expect(() => deriveKeyEncryptionKey({ machineId: MACHINE_A, uid })).toThrowError(DomainError);
    }
  });
});

describe('wrapping the master key envelope', () => {
  const kek = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1000 });
  const envelope = Buffer.from('a master key envelope, 41 bytes in practice', 'utf8');

  it('round-trips', () => {
    const wrapped = wrapWithMachineKey(envelope, kek);

    expect(unwrapWithMachineKey(wrapped, kek, 'key.mkey').equals(envelope)).toBe(true);
  });

  it('never emits the same bytes twice for the same input', () => {
    // A fresh nonce every time. Identical output would leak that the key was
    // rewritten with the same value.
    const once = wrapWithMachineKey(envelope, kek);
    const twice = wrapWithMachineKey(envelope, kek);

    expect(once.equals(twice)).toBe(false);
    expect(unwrapWithMachineKey(twice, kek, 'key.mkey').equals(envelope)).toBe(true);
  });

  it('refuses to open under another machine key', () => {
    // The property the whole scheme exists for: a secrets folder copied to
    // another machine cannot be read there.
    const elsewhere = deriveKeyEncryptionKey({ machineId: MACHINE_B, uid: 1000 });
    const wrapped = wrapWithMachineKey(envelope, kek);

    try {
      unwrapWithMachineKey(wrapped, elsewhere, 'copied.mkey');
      expect.unreachable('a foreign key must not open the envelope');
    } catch (error) {
      expect((error as DomainError).blockers).toContain('machine_key_unwrap_failed');
      expect((error as DomainError).message).toMatch(/copied from another machine/i);
    }
  });

  it('refuses to open under another user on the same machine', () => {
    const otherUser = deriveKeyEncryptionKey({ machineId: MACHINE_A, uid: 1001 });
    const wrapped = wrapWithMachineKey(envelope, kek);

    expect(() => unwrapWithMachineKey(wrapped, otherUser, 'other.mkey')).toThrowError(DomainError);
  });

  it('detects a flipped bit in the ciphertext', () => {
    const wrapped = wrapWithMachineKey(envelope, kek);
    const tampered = Buffer.from(wrapped);
    const last = tampered.length - 1;
    tampered.writeUInt8(tampered.readUInt8(last) ^ 0x01, last);

    expect(() => unwrapWithMachineKey(tampered, kek, 'tampered.mkey')).toThrowError(DomainError);
  });

  it('detects a flipped bit in the authentication tag', () => {
    const wrapped = wrapWithMachineKey(envelope, kek);
    const tampered = Buffer.from(wrapped);
    tampered.writeUInt8(tampered.readUInt8(14) ^ 0x01, 14);

    expect(() => unwrapWithMachineKey(tampered, kek, 'tampered.mkey')).toThrowError(DomainError);
  });

  it('rejects a relabelled version rather than parsing it under the wrong rules', () => {
    const wrapped = wrapWithMachineKey(envelope, kek);
    const relabelled = Buffer.from(wrapped);
    relabelled[0] = 2;

    try {
      unwrapWithMachineKey(relabelled, kek, 'v2.mkey');
      expect.unreachable('an unknown version must be refused');
    } catch (error) {
      expect((error as DomainError).blockers).toContain('sealed_key_bad_format');
    }
  });

  it('rejects a blob too short to contain a nonce and a tag', () => {
    // What a Windows DPAPI file, or a truncated write, looks like from here.
    for (const bogus of [Buffer.alloc(0), Buffer.of(1), Buffer.alloc(28, 1)]) {
      try {
        unwrapWithMachineKey(bogus, kek, 'short.mkey');
        expect.unreachable('a short blob must be refused');
      } catch (error) {
        expect((error as DomainError).blockers).toContain('sealed_key_bad_format');
      }
    }
  });
});
