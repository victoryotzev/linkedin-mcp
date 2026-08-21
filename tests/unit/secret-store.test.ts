import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Row, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
// Imported by path rather than through the package barrel: the orchestrator
// owns packages/domain/src/index.ts and wires this export up separately.
import {
  SECRET_NAMES,
  createSecretStore,
  type SecretStore,
} from '../../packages/domain/src/secretStore.ts';

// DPAPI is only reachable through Windows PowerShell. Everywhere else the
// crypto assertions are skipped rather than softened — a green run on Linux
// must not read as evidence that secret storage works.
function dpapiAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  const systemRoot = process.env['SystemRoot'];
  const exe = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const probe = spawnSync(
    exe,
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; exit 0'],
    { windowsHide: true, timeout: 20_000 },
  );
  return probe.status === 0;
}

const HAS_DPAPI = dpapiAvailable();

const READ_TOKEN = 'AQV-read-lane-fake-token-0123456789';
const WRITE_TOKEN = 'AQV-write-lane-fake-token-abcdefghij';

let dir: string;
let db: SqliteDriver;
let store: SecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-sec-'));
  db = openDatabase(join(dir, 'data', 't.sqlite3')).db;
  migrate(db);
  store = createSecretStore(db, dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

function secretRow(name: string): Row {
  const row = db.get('SELECT ciphertext, iv, auth_tag, key_id FROM secrets WHERE name = ?', name);
  if (row === undefined) throw new Error(`expected a secrets row for ${name}`);
  return row;
}

function bytes(row: Row, column: string): Buffer {
  return Buffer.from(row[column] as Uint8Array);
}

describe('secret store (no DPAPI required)', () => {
  it('returns null for an unknown name without wrapping a master key', async () => {
    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBeNull();
    expect(store.has(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(false);
    expect(store.listNames()).toEqual([]);
    // A read miss must not cost a PowerShell spawn, so no key file appears.
    expect(existsSync(join(dir, 'secrets', 'master.key.dpapi'))).toBe(false);
  });

  it('refuses names outside the allowlist and empty values', async () => {
    expect(await codeOf(() => store.put('linkedin.client_secret', 'x'))).toBe('INVALID_INPUT');
    expect(await codeOf(() => store.put(SECRET_NAMES.ACCESS_TOKEN_READ, '  \n'))).toBe(
      'INVALID_INPUT',
    );
    expect(existsSync(join(dir, 'secrets', 'master.key.dpapi'))).toBe(false);
  });
});

describe.skipIf(!HAS_DPAPI)('secret store (DPAPI)', () => {
  it('round-trips a value through put/get', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(READ_TOKEN);
    expect(store.has(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(true);

    // Overwriting rotates in place rather than adding a second row.
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, `${READ_TOKEN}-rotated`);
    expect(await store.get(SECRET_NAMES.ACCESS_TOKEN_READ)).toBe(`${READ_TOKEN}-rotated`);
    expect(store.listNames()).toEqual([SECRET_NAMES.ACCESS_TOKEN_READ]);
  });

  it('unwraps the master key from disk in a fresh store instance', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_WRITE, WRITE_TOKEN);
    // A second instance holds no cached key, so this exercises the real
    // DPAPI Unprotect path against the file rather than process memory.
    const reopened = createSecretStore(db, dir);
    expect(await reopened.get(SECRET_NAMES.ACCESS_TOKEN_WRITE)).toBe(WRITE_TOKEN);
  });

  it('stores ciphertext, not the plaintext, and keeps the key file opaque', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    const row = secretRow(SECRET_NAMES.ACCESS_TOKEN_READ);
    const ciphertext = bytes(row, 'ciphertext');

    expect(ciphertext.includes(Buffer.from(READ_TOKEN, 'utf8'))).toBe(false);
    expect(ciphertext.toString('latin1')).not.toContain(READ_TOKEN);
    // GCM is a stream cipher: equal length, no padding to hide behind.
    expect(ciphertext).toHaveLength(Buffer.byteLength(READ_TOKEN, 'utf8'));
    expect(bytes(row, 'iv')).toHaveLength(12);
    expect(bytes(row, 'auth_tag')).toHaveLength(16);
    expect(String(row['key_id'])).toMatch(/^mk_[0-9a-f]{16}$/);

    const keyFile = readFileSync(join(dir, 'secrets', 'master.key.dpapi'), 'utf8');
    expect(keyFile.length).toBeGreaterThan(0);
    expect(keyFile).not.toContain(READ_TOKEN);
  });

  it('lists names and removes a secret', async () => {
    await store.put(SECRET_NAMES.CLIENT_ID_WRITE, '77abcdefghij');
    await store.put(SECRET_NAMES.CLIENT_ID_READ, '88abcdefghij');
    expect(store.listNames()).toEqual([SECRET_NAMES.CLIENT_ID_READ, SECRET_NAMES.CLIENT_ID_WRITE]);

    await store.remove(SECRET_NAMES.CLIENT_ID_WRITE);
    expect(store.has(SECRET_NAMES.CLIENT_ID_WRITE)).toBe(false);
    expect(await store.get(SECRET_NAMES.CLIENT_ID_WRITE)).toBeNull();
    expect(store.listNames()).toEqual([SECRET_NAMES.CLIENT_ID_READ]);

    // Removing something that was never there is not an error.
    await store.remove(SECRET_NAMES.ACCESS_TOKEN_WRITE);
  });

  it('fails closed when the auth tag is tampered with', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    const tag = bytes(secretRow(SECRET_NAMES.ACCESS_TOKEN_READ), 'auth_tag');
    tag.writeUInt8(tag.readUInt8(0) ^ 0xff, 0);
    db.run('UPDATE secrets SET auth_tag = ? WHERE name = ?', tag, SECRET_NAMES.ACCESS_TOKEN_READ);
    expect(await codeOf(() => store.get(SECRET_NAMES.ACCESS_TOKEN_READ))).toBe('INTEGRITY_ERROR');
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    const ciphertext = bytes(secretRow(SECRET_NAMES.ACCESS_TOKEN_READ), 'ciphertext');
    ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 0xff, 0);
    db.run(
      'UPDATE secrets SET ciphertext = ? WHERE name = ?',
      ciphertext,
      SECRET_NAMES.ACCESS_TOKEN_READ,
    );
    expect(await codeOf(() => store.get(SECRET_NAMES.ACCESS_TOKEN_READ))).toBe('INTEGRITY_ERROR');
  });

  it('refuses a ciphertext moved from another name', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    await store.put(SECRET_NAMES.ACCESS_TOKEN_WRITE, WRITE_TOKEN);
    const readRow = secretRow(SECRET_NAMES.ACCESS_TOKEN_READ);
    // The name is authenticated data, so swapping the read-lane token into the
    // write-lane row must not silently publish with the wrong credential.
    db.run(
      'UPDATE secrets SET ciphertext = ?, iv = ?, auth_tag = ? WHERE name = ?',
      bytes(readRow, 'ciphertext'),
      bytes(readRow, 'iv'),
      bytes(readRow, 'auth_tag'),
      SECRET_NAMES.ACCESS_TOKEN_WRITE,
    );
    expect(await codeOf(() => store.get(SECRET_NAMES.ACCESS_TOKEN_WRITE))).toBe('INTEGRITY_ERROR');
  });

  it('reports a deleted master key rather than minting a useless new one', async () => {
    await store.put(SECRET_NAMES.ACCESS_TOKEN_READ, READ_TOKEN);
    rmSync(join(dir, 'secrets'), { recursive: true, force: true, maxRetries: 3 });
    // A fresh instance has nothing cached, so this is the post-purge / restored
    // -on-another-machine case a user actually hits.
    const reopened = createSecretStore(db, dir);
    expect(await codeOf(() => reopened.get(SECRET_NAMES.ACCESS_TOKEN_READ))).toBe(
      'INTEGRITY_ERROR',
    );
  });
});
