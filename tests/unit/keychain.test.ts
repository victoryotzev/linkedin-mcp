import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Row, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import {
  KEYCHAIN_ITEM,
  readOrCreateKeychainKey,
  type KeychainResult,
  type KeychainRunner,
} from '../../packages/domain/src/keychain.ts';
import {
  SECRET_NAMES,
  createSecretStore,
  keychainKeyWrapper,
} from '../../packages/domain/src/secretStore.ts';

// The macOS vault, exercised on whatever host is running the suite.
//
// `security` is injected, so every branch here is reachable without a Mac —
// including the ones a Mac would make hard to produce on purpose: a locked
// keychain, an item someone edited by hand, a racing process that wrote a
// different key between our add and our read.
//
// A real Mac still runs all of this: macos-latest is in the CI matrix, and
// there the injected runner is the only thing standing in for the binary. What
// that lane proves and this file cannot is that `security` itself behaves as
// assumed — the exit codes, and that a `-T`-authorised read does not prompt.

const NOT_FOUND = 44;
const READ_TOKEN = 'AQV-read-lane-fake-token-0123456789';

/** An in-memory `security`, recording what it was asked to do. */
function fakeKeychain(options: { initial?: string; failOn?: string; exitCode?: number } = {}) {
  let stored: string | null = options.initial ?? null;
  const calls: string[][] = [];

  const run: KeychainRunner = (args) => {
    calls.push([...args]);
    const verb = args[0] ?? '';
    if (options.failOn === verb) {
      return Promise.resolve({ code: options.exitCode ?? 1, stdout: '' } satisfies KeychainResult);
    }
    if (verb === 'find-generic-password') {
      return Promise.resolve(
        stored === null
          ? ({ code: NOT_FOUND, stdout: '' } satisfies KeychainResult)
          : ({ code: 0, stdout: `${stored}\n` } satisfies KeychainResult),
      );
    }
    if (verb === 'add-generic-password') {
      const at = args.indexOf('-w');
      stored = at >= 0 ? (args[at + 1] ?? null) : null;
      return Promise.resolve({ code: 0, stdout: '' } satisfies KeychainResult);
    }
    return Promise.resolve({ code: 1, stdout: '' } satisfies KeychainResult);
  };

  return {
    run,
    calls,
    get stored() {
      return stored;
    },
    set stored(value: string | null) {
      stored = value;
    },
  };
}

describe('fetching the vault key from the Keychain', () => {
  it('returns the key that is already there, without writing anything', async () => {
    const existing = Buffer.alloc(32, 7).toString('base64');
    const keychain = fakeKeychain({ initial: existing });

    const key = await readOrCreateKeychainKey(keychain.run);

    expect(key.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(keychain.calls.map((c) => c[0])).toEqual(['find-generic-password']);
  });

  it('creates a random key on first use, then reads it back', async () => {
    const keychain = fakeKeychain();

    const key = await readOrCreateKeychainKey(keychain.run);

    expect(key).toHaveLength(32);
    // Read back rather than trusting the write: `-U` means a racing process may
    // already have stored a different key, and that key is the one every row it
    // encrypted is sealed under.
    expect(keychain.calls.map((c) => c[0])).toEqual([
      'find-generic-password',
      'add-generic-password',
      'find-generic-password',
    ]);
    expect(Buffer.from(keychain.stored ?? '', 'base64').equals(key)).toBe(true);
  });

  it('yields to a key another process stored while this one was creating its own', async () => {
    const winner = Buffer.alloc(32, 9).toString('base64');
    const keychain = fakeKeychain();
    const original = keychain.run;
    const racing: KeychainRunner = async (args) => {
      const result = await original(args);
      // Between our add and our read-back, somebody else wins the race.
      if (args[0] === 'add-generic-password') keychain.stored = winner;
      return result;
    };

    const key = await readOrCreateKeychainKey(racing);

    expect(key.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it('puts the security binary on the item ACL, so later reads never prompt', async () => {
    const keychain = fakeKeychain();

    await readOrCreateKeychainKey(keychain.run);

    const add = keychain.calls.find((c) => c[0] === 'add-generic-password') ?? [];
    // Without -T, a read raises an authorization dialog — and an MCP-started
    // server has no terminal and nobody watching to answer one.
    expect(add).toContain('-T');
    expect(add[add.indexOf('-T') + 1]).toBe('/usr/bin/security');
    // -U so a racing creator is updated rather than the call failing outright.
    expect(add).toContain('-U');
    expect(add).toContain(KEYCHAIN_ITEM.service);
    expect(add).toContain(KEYCHAIN_ITEM.account);
  });

  it('reports a locked keychain as retryable rather than as corruption', async () => {
    const keychain = fakeKeychain({ failOn: 'find-generic-password', exitCode: 51 });

    try {
      await readOrCreateKeychainKey(keychain.run);
      expect.unreachable('a failing lookup must throw');
    } catch (error) {
      const failure = error as DomainError;
      expect(failure.blockers).toContain('keychain_unavailable');
      expect(failure.retryable).toBe(true);
      expect(failure.message).toMatch(/unlock it and retry/i);
    }
  });

  it('says nothing was stored when the write is refused', async () => {
    const keychain = fakeKeychain({ failOn: 'add-generic-password', exitCode: 1 });

    try {
      await readOrCreateKeychainKey(keychain.run);
      expect.unreachable('a refused write must throw');
    } catch (error) {
      const failure = error as DomainError;
      expect(failure.blockers).toContain('keychain_store_failed');
      expect(failure.message).toMatch(/no secret was stored/i);
    }
  });

  it('refuses an item that is not what this product wrote', async () => {
    for (const bogus of ['not base64!!', 'hello world']) {
      const keychain = fakeKeychain({ initial: bogus });
      await expect(readOrCreateKeychainKey(keychain.run)).rejects.toThrowError(
        /not the value this product wrote/i,
      );
    }
  });

  it('refuses an item of the wrong length, which would silently weaken the seal', async () => {
    const keychain = fakeKeychain({ initial: Buffer.alloc(16, 1).toString('base64') });

    try {
      await readOrCreateKeychainKey(keychain.run);
      expect.unreachable('a short key must be refused');
    } catch (error) {
      expect((error as DomainError).blockers).toContain('keychain_item_malformed');
      expect((error as DomainError).message).toMatch(/16 bytes, not 32/);
    }
  });

  it('reports a write that succeeds and then cannot be read back', async () => {
    const keychain = fakeKeychain();
    const swallowing: KeychainRunner = async (args) => {
      const result = await keychain.run(args);
      if (args[0] === 'add-generic-password') keychain.stored = null;
      return result;
    };

    await expect(readOrCreateKeychainKey(swallowing)).rejects.toThrowError(
      /accepted the vault key and then did not return it/i,
    );
  });
});

describe('the vault on a Keychain host', () => {
  let dir: string;
  let db: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-kc-'));
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

  it('stores and returns a token, end to end', async () => {
    const keychain = fakeKeychain();
    const store = createSecretStore(db, dir, { wrapper: keychainKeyWrapper(keychain.run) });

    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(READ_TOKEN);
    // The sealed envelope is on disk; the key that opens it is not.
    expect(existsSync(join(dir, 'secrets', 'master.key.keychain'))).toBe(true);
    const onDisk = readFileSync(join(dir, 'secrets', 'master.key.keychain'), 'utf8');
    expect(onDisk).not.toContain(keychain.stored ?? 'never-null');
  });

  it('never writes the plaintext into the database', async () => {
    const keychain = fakeKeychain();
    const store = createSecretStore(db, dir, { wrapper: keychainKeyWrapper(keychain.run) });

    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);

    expect(JSON.stringify(db.all('SELECT * FROM secrets') as Row[])).not.toContain(READ_TOKEN);
  });

  it('cannot be opened with another Mac’s Keychain key', async () => {
    // The property the Keychain buys: the sealed file travelled, the key did
    // not, and the key is random rather than derivable from anything portable.
    const mine = fakeKeychain();
    await createSecretStore(db, dir, { wrapper: keychainKeyWrapper(mine.run) }).put(
      SECRET_NAMES.ACCESS_TOKEN_READ,
      READ_TOKEN,
    );

    const theirs = fakeKeychain({ initial: Buffer.alloc(32, 3).toString('base64') });
    const elsewhere = createSecretStore(db, dir, { wrapper: keychainKeyWrapper(theirs.run) });

    try {
      await elsewhere.get(SECRET_NAMES.ACCESS_TOKEN_READ);
      expect.unreachable('a foreign Keychain key must not open the vault');
    } catch (error) {
      const failure = error as DomainError;
      expect(failure.blockers).toContain('keychain_unwrap_failed');
      expect(failure.message).toMatch(/copied from another Mac/i);
      expect(failure.message).toMatch(/delete that folder/i);
    }
  });

  it('asks the Keychain once per wrapper, not once per operation', async () => {
    const keychain = fakeKeychain({ initial: Buffer.alloc(32, 5).toString('base64') });
    const store = createSecretStore(db, dir, { wrapper: keychainKeyWrapper(keychain.run) });

    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    await store.put(SECRET_NAMES.ACCESS_TOKEN_WRITE, 'AQV-write-lane-fake-token-abcdefghij');
    await store.get(SECRET_NAMES.ACCESS_TOKEN_READ);

    expect(keychain.calls).toHaveLength(1);
  });

  it('retries the Keychain after a failure instead of staying broken', async () => {
    // A locked keychain that is then unlocked must not poison the store for the
    // life of the process.
    let locked = true;
    const inner = fakeKeychain();
    const flaky: KeychainRunner = (args) =>
      locked ? Promise.resolve({ code: 51, stdout: '' }) : inner.run(args);

    const store = createSecretStore(db, dir, { wrapper: keychainKeyWrapper(flaky) });
    await expect(store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN)).rejects.toThrowError(
      DomainError,
    );

    locked = false;
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(READ_TOKEN);
  });

  it('refuses a sealed file written under a different scheme', async () => {
    const keychain = fakeKeychain();
    await createSecretStore(db, dir, { wrapper: keychainKeyWrapper(keychain.run) }).put(
      SECRET_NAMES.ACCESS_TOKEN_READ,
      READ_TOKEN,
    );
    // What a renamed Windows master.key.dpapi looks like from here.
    writeFileSync(
      join(dir, 'secrets', 'master.key.keychain'),
      'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA',
      'utf8',
    );

    const store = createSecretStore(db, dir, { wrapper: keychainKeyWrapper(keychain.run) });
    await expect(store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).rejects.toThrowError(DomainError);
  });
});
