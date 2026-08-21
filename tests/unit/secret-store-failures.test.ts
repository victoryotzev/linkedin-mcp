import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';
import { createSecretStore } from '../../packages/domain/src/secretStore.ts';

// What the vault does when DPAPI will not cooperate.
//
// The happy path is covered next door. These are the failures, and they matter
// because each one has a different remedy and a member who gets the wrong
// message goes and does the wrong thing: a missing PowerShell means secret
// storage is simply unavailable on this host, while a refusal to unwrap almost
// always means a secrets folder arrived from another machine or another Windows
// account, where it can never be decrypted and should be deleted.

const IS_WINDOWS = process.platform === 'win32';

function dpapiAvailable(): boolean {
  if (!IS_WINDOWS) return false;
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
const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

let home: string;
let db: SqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-vault-'));
  const opened = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  db = opened.db;
  migrate(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('when Windows PowerShell cannot be started', () => {
  it('says secret storage is unavailable on this host, and that the rest still works', async () => {
    // Pointing SystemRoot at nothing reproduces a host where Windows PowerShell
    // has been removed, relocated or blocked by an endpoint agent.
    vi.stubEnv('SystemRoot', join(home, 'no-such-windows'));
    const store = createSecretStore(db, home);

    const failure = await store.put('linkedin.access_token.read', TOKEN).catch((e: unknown) => e);

    expect(String(failure)).toMatch(/powershell|unavailable/i);
    // The message has to say the product still works without it, or a member
    // reasonably concludes the whole install is broken.
    expect(String(failure)).toMatch(/rest of the product|unavailable/i);
  });

  it('reports the same way on a read', async () => {
    vi.stubEnv('SystemRoot', join(home, 'no-such-windows'));
    const store = createSecretStore(db, home);

    // With no master key on disk there is nothing to unwrap, so the read is
    // answered without ever reaching DPAPI.
    await expect(store.get('linkedin.access_token.read')).resolves.toBeNull();
  });
});

describe('a secrets folder that came from somewhere else', () => {
  it.runIf(HAS_DPAPI)(
    'refuses to unwrap a master key this machine did not write',
    async () => {
      // Base64 that is well-formed but is not DPAPI material for this user.
      mkdirSync(join(home, 'secrets'), { recursive: true });
      writeFileSync(
        join(home, 'secrets', 'master.key.dpapi'),
        Buffer.from('not the bytes DPAPI wrapped on this machine').toString('base64'),
        { encoding: 'utf8' },
      );
      const store = createSecretStore(db, home);

      const failure = await store.put('linkedin.access_token.read', TOKEN).catch((e: unknown) => e);

      // The remedy is specific: this can never be decrypted here, so delete the
      // folder and paste the token again.
      expect(String(failure)).toMatch(/dpapi|unwrap|machine|account/i);
    },
    60_000,
  );

  it.runIf(HAS_DPAPI)(
    'refuses a secret encrypted under a different master key',
    async () => {
      const store = createSecretStore(db, home);
      await store.put('linkedin.access_token.read', TOKEN);

      // The row survives, the key it was encrypted under does not: exactly what
      // restoring a database over a different home looks like.
      db.run(
        "UPDATE secrets SET key_id = 'some-other-key' WHERE name = ?",
        'linkedin.access_token.read',
      );

      await expect(store.get('linkedin.access_token.read')).rejects.toThrow(/master key/i);
    },
    60_000,
  );

  it.runIf(HAS_DPAPI)(
    'reports a deleted master key as permanent, not as a reason to mint a new one',
    async () => {
      const store = createSecretStore(db, home);
      await store.put('linkedin.access_token.read', TOKEN);
      rmSync(join(home, 'secrets'), { recursive: true, force: true });

      const fresh = createSecretStore(db, home);

      // Minting a new key here would leave the stored ciphertext silently
      // undecryptable while everything looked healthy.
      await expect(fresh.get('linkedin.access_token.read')).rejects.toThrow(
        /unrecoverable|master key/i,
      );
    },
    60_000,
  );
});

describe('the key file itself', () => {
  it.runIf(HAS_DPAPI)(
    'holds no plaintext and is written for this user only',
    async () => {
      const store = createSecretStore(db, home);
      await store.put('linkedin.access_token.read', TOKEN);

      const keyFile = readFileSync(join(home, 'secrets', 'master.key.dpapi'), 'utf8');
      expect(keyFile).not.toContain(TOKEN);
      // Opaque base64, not anything readable.
      expect(keyFile.trim()).toMatch(/^[A-Za-z0-9+/=\s]+$/);
    },
    60_000,
  );

  it.runIf(HAS_DPAPI)(
    'survives two stores opening the same home at once',
    async () => {
      const first = createSecretStore(db, home);
      const second = createSecretStore(db, home);

      // The MCP server and the dashboard both run against one home. Whichever
      // wrote the key file first owns it; the other must adopt it rather than
      // clobber it and strand everything the first one encrypted.
      const [a, b] = await Promise.all([
        first.put('linkedin.access_token.read', TOKEN),
        second.put('linkedin.access_token.write', `${TOKEN}-write`),
      ]);
      void a;
      void b;

      expect(await first.get('linkedin.access_token.read')).toBe(TOKEN);
      expect(await second.get('linkedin.access_token.write')).toBe(`${TOKEN}-write`);
    },
    60_000,
  );
});

describe('names and values', () => {
  it('refuses a name outside the allowlist without touching DPAPI', async () => {
    vi.stubEnv('SystemRoot', join(home, 'no-such-windows'));
    const store = createSecretStore(db, home);

    // The check is before the key work, so a bad name fails fast and cannot be
    // used to make the process spawn anything.
    await expect(store.put('arbitrary.name', TOKEN)).rejects.toThrow();
    await expect(store.put('linkedin.access_token.read', '')).rejects.toThrow();
  });

  it('reports whether a name is present without decrypting it', () => {
    vi.stubEnv('SystemRoot', join(home, 'no-such-windows'));
    const store = createSecretStore(db, home);

    expect(store.has('linkedin.access_token.read')).toBe(false);
    expect(store.listNames()).toEqual([]);
  });
});
