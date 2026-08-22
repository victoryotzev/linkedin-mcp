import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Row, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import {
  SECRET_NAMES,
  createSecretStore,
  machineKeyWrapper,
  masterKeyFileName,
} from '../../packages/domain/src/secretStore.ts';

// The credential vault as it works on Linux, exercised on whatever host is
// running the suite.
//
// The Windows path needs real DPAPI and is covered in secret-store.test.ts,
// which skips when PowerShell cannot answer. This one needs nothing from the
// operating system: the machine identity is injected, so the Linux vault gets
// the same end-to-end coverage from a Windows runner that DPAPI gets from a
// Linux one — which is to say, the platform each is least likely to be
// developed on still proves it.

const MACHINE_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const MACHINE_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';
const READ_TOKEN = 'AQV-read-lane-fake-token-0123456789';
const WRITE_TOKEN = 'AQV-write-lane-fake-token-abcdefghij';

let dir: string;
let db: SqliteDriver;

const wrapperFor = (machineId: string, uid = 1000) => machineKeyWrapper({ machineId, uid });
const storeOn = (machineId: string, uid = 1000) =>
  createSecretStore(db, dir, { wrapper: wrapperFor(machineId, uid) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-mkey-'));
  db = openDatabase(join(dir, 'data', 't.sqlite3')).db;
  migrate(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the vault on a machine-key host', () => {
  it('stores and returns a token', async () => {
    const store = storeOn(MACHINE_A);

    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(READ_TOKEN);
    expect(store.has(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(true);
  });

  it('writes its key under a name of its own, not the DPAPI one', () => {
    // A secrets folder carried between platforms is then simply not found, and
    // the vault starts fresh, rather than handing DPAPI a blob it will reject
    // with a message about corruption.
    expect(masterKeyFileName('linux')).toBe('master.key.mkey');
    expect(masterKeyFileName('darwin')).toBe('master.key.mkey');
    expect(masterKeyFileName('win32')).toBe('master.key.dpapi');
  });

  it('creates the key file once and reuses it across stores', async () => {
    const keyPath = join(dir, 'secrets', 'master.key.mkey');
    await storeOn(MACHINE_A).put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    expect(existsSync(keyPath)).toBe(true);
    const first = readFileSync(keyPath, 'utf8');

    // A second store on the same host opens what the first sealed.
    const second = storeOn(MACHINE_A);
    expect(await second.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(READ_TOKEN);
    await second.put(SECRET_NAMES.ACCESS_TOKEN_WRITE, WRITE_TOKEN);

    expect(readFileSync(keyPath, 'utf8')).toBe(first);
    expect(await second.get(SECRET_NAMES.ACCESS_TOKEN_WRITE)).toBe(WRITE_TOKEN);
  });

  it('keeps the two lanes separate', async () => {
    const store = storeOn(MACHINE_A);
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    await store.put(SECRET_NAMES.ACCESS_TOKEN_WRITE, WRITE_TOKEN);

    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(READ_TOKEN);
    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_WRITE)).toBe(WRITE_TOKEN);
    expect(store.listNames()).toEqual(
      [SECRET_NAMES.ACCESS_TOKEN_READ, SECRET_NAMES.ACCESS_TOKEN_WRITE].sort(),
    );
  });

  it('never writes the plaintext into the database', async () => {
    const store = storeOn(MACHINE_A);
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    const rows = db.all('SELECT * FROM secrets') as Row[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(READ_TOKEN);
  });

  it('removes a secret', async () => {
    const store = storeOn(MACHINE_A);
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    await store.remove(SECRET_NAMES.ACCESS_TOKEN_READ);

    expect(store.has(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(false);
    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBeNull();
  });
});

describe('a data home moved somewhere it does not belong', () => {
  it('cannot be opened on another machine', async () => {
    // The property the derivation exists for. The database and the sealed key
    // travelled; the machine id did not.
    await storeOn(MACHINE_A).put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    const elsewhere = storeOn(MACHINE_B);

    await expect(elsewhere.get(SECRET_NAMES.ACCESS_TOKEN_READ)).rejects.toThrowError(DomainError);
  });

  it('cannot be opened by another account on the same machine', async () => {
    await storeOn(MACHINE_A, 1000).put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    const otherUser = storeOn(MACHINE_A, 1001);

    await expect(otherUser.get(SECRET_NAMES.ACCESS_TOKEN_READ)).rejects.toThrowError(DomainError);
  });

  it('says what happened, and what to do about it', async () => {
    await storeOn(MACHINE_A).put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    try {
      await storeOn(MACHINE_B).get(SECRET_NAMES.ACCESS_TOKEN_READ);
      expect.unreachable('a foreign machine must not open the vault');
    } catch (error) {
      const failure = error as DomainError;
      expect(failure.blockers).toContain('machine_key_unwrap_failed');
      // The member is told the remedy, not just that something failed.
      expect(failure.message).toMatch(/copied from another machine/i);
      expect(failure.message).toMatch(/delete that folder/i);
    }
  });

  it('refuses a key file written by a different scheme', async () => {
    // What a Windows master.key.dpapi looks like if someone renames it.
    const secrets = join(dir, 'secrets');
    await storeOn(MACHINE_A).put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    writeFileSync(join(secrets, 'master.key.mkey'), 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA', 'utf8');

    try {
      await storeOn(MACHINE_A).get(SECRET_NAMES.ACCESS_TOKEN_READ);
      expect.unreachable('a foreign key format must be refused');
    } catch (error) {
      expect((error as DomainError).blockers).toEqual(
        expect.arrayContaining([expect.stringMatching(/machine_key_(bad_format|unwrap_failed)/)]),
      );
    }
  });
});

describe('the store is built before it is needed', () => {
  it('constructs without touching any key material', () => {
    // Constructing the store must not require a vault that works: a host with
    // no machine id still has to run everything that needs no credential.
    // `linux` is passed so this exercises the machine-key branch even on
    // Windows, and nothing here should reach the wrapper at all.
    expect(() => createSecretStore(db, dir, { platform: 'linux' })).not.toThrow();
    expect(existsSync(join(dir, 'secrets'))).toBe(false);
  });

  it('reports an unsupported platform only when a secret is actually asked for', async () => {
    const store = createSecretStore(db, dir, { platform: 'sunos' });

    await expect(store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN)).rejects.toThrowError(
      /no key protection for sunos/i,
    );
  });
});
